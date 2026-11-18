import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectMongo, assertMongoTransactionsSupported, runMongoTransaction } from '../api/_lib/mongo.js'
import { User, Workspace, WorkspaceMember, Project, ProjectVersion, ProjectMember, ProjectDraft, ScadaAsset, Connector, ConnectorEnvironment, ConnectorSecret, AuditEvent } from '../api/_lib/models.js'
import { hashPassword, bootstrapOwnerId } from '../api/_lib/auth.js'
import { encryptConnectorSecret, connectorSecretId, inspectConnectorSecretKey } from '../api/_lib/connector-secrets.js'
import { thingsBoardAuthenticationMetadata } from '../api/_lib/thingsboard-auth.js'
import { hashProjectPin, projectPinError } from '../api/_lib/project-pin.js'
import { verifyDeployment } from './contract.js'
import { hostedRuntimeAccess } from '../shared/hosted-runtime-policy.js'

export function readDeployment(root) {
  return verifyDeployment(JSON.parse(readFileSync(resolve(root, 'deployment.json'), 'utf8')))
}

export function provisioningInput(deployment, environment = process.env, configuredConnectors = new Set()) {
  verifyDeployment(deployment)
  const email = String(environment.SCADA_ADMIN_EMAIL || '').trim().toLowerCase()
  const password = String(environment.SCADA_ADMIN_PASSWORD || '')
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || password.length > 256) throw new Error('Set SCADA_ADMIN_EMAIL and a target SCADA_ADMIN_PASSWORD of 10–256 characters.')
  if (!/^mongodb(?:\+srv)?:\/\/[^/]+\/[^?\s/]+(?:\?|$)/.test(environment.MONGO_URI || '')) throw new Error('Set a dedicated MONGO_URI with an explicit database name for this hosted runtime.')
  const origin = new URL(environment.APP_ORIGIN || '')
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && environment.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new Error('APP_ORIGIN must be the exact HTTPS deployment origin.')
  const pin = String(environment.SCADA_RUNTIME_PIN || '')
  if (deployment.payload.project.pinRequired && projectPinError(pin)) throw new Error('Set a valid target SCADA_RUNTIME_PIN for the protected project.')
  let credentials
  try { credentials = JSON.parse(environment.RUNTIME_THINGSBOARD_CREDENTIALS || '{}') } catch { throw new Error('RUNTIME_THINGSBOARD_CREDENTIALS must be a JSON object keyed by connector ID.') }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Invalid ThingsBoard credential configuration.')
  const secrets = deployment.payload.connectors.map(connector => {
    const masterKey = String(environment.SCADA_CONNECTOR_MASTER_KEY || '')
    if (!/^[a-f0-9]{64}$/i.test(masterKey) && !(/^[A-Za-z0-9+/]{43}=?$/.test(masterKey) && Buffer.from(masterKey, 'base64').length === 32)) throw new Error('Set a fresh 32-byte SCADA_CONNECTOR_MASTER_KEY on the target.')
    const hosts = String(environment.CONNECTOR_ALLOWED_HOSTS || '').split(',').map(host => host.trim().toLowerCase())
    if (!hosts.includes(new URL(connector.config.serverUrl).hostname)) throw new Error('Add the ThingsBoard hostname to CONNECTOR_ALLOWED_HOSTS.')
    if (configuredConnectors.has(`${connector.id}:${connector.environmentRef}`)) return { connector }
    const input = credentials[`${connector.id}:${connector.environmentRef}`] || credentials[connector.id]
    if (!input?.jwt || typeof input.jwt !== 'string') throw new Error(`Configure a target ThingsBoard JWT for ${connector.id}:${connector.environmentRef}.`)
    const secret = { jwt: input.jwt, ...(input.refreshToken ? { refreshToken: String(input.refreshToken) } : {}) }
    const metadata = thingsBoardAuthenticationMetadata(secret)
    if (metadata.accessTokenExpiresAt && metadata.accessTokenExpiresAt.getTime() <= Date.now()) throw new Error('A configured target ThingsBoard JWT has expired.')
    return { connector, secret, metadata }
  })
  return { email, password, pin, secrets, origin: origin.origin, ...hostedRuntimeAccess(deployment.policy) }
}

export async function provisionDeployment(deployment, environment = process.env) {
  verifyDeployment(deployment)
  const connection = await connectMongo()
  await assertMongoTransactionsSupported(connection)
  const registry = connection.connection.db.collection('scamatic_hosted_deployments')
  const existing = await registry.findOne({ _id: deployment.deploymentId })
  if (!existing) {
    const collections = await connection.connection.db.listCollections({}, { nameOnly: true }).toArray()
    const documents = await Promise.all(collections.filter(item => !item.name.startsWith('system.')).map(item => connection.connection.db.collection(item.name).findOne({}, { projection: { _id: 1 } })))
    if (documents.some(Boolean)) throw new Error('First import requires an empty dedicated runtime database. Existing data is never overwritten.')
  }
  if (await Project.exists({ _id: { $ne: deployment.payload.project.id } }) || await ProjectDraft.exists({})) throw new Error('Database contains unrelated projects or Builder drafts.')
  if (existing && (existing.projectId !== deployment.payload.project.id || existing.workspaceId !== deployment.payload.project.workspaceId)) throw new Error('Runtime deployment ownership does not match.')
  const configured = new Set()
  if (existing) for (const connector of deployment.payload.connectors) {
    const secret = await ConnectorSecret.findById(connectorSecretId(connector.id, connector.environmentRef)).select('+wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion').lean()
    const environment = await ConnectorEnvironment.findOne({ connectorId: connector.id, environmentRef: connector.environmentRef, projectId: deployment.payload.project.id, workspaceId: deployment.payload.project.workspaceId }).lean()
    if (secret && environment?.secretConfiguredAt) {
      inspectConnectorSecretKey(secret, { connectorId: connector.id, environmentRef: connector.environmentRef })
      configured.add(`${connector.id}:${connector.environmentRef}`)
    }
  }
  const input = provisioningInput(deployment, environment, configured)
  if (existing?.payloadChecksum === deployment.payloadChecksum) return
  const { project, version, assets } = deployment.payload
  const userId = bootstrapOwnerId(input.email)
  const passwordHash = await hashPassword(input.password)
  const pinHash = project.pinRequired ? await hashProjectPin(input.pin) : null
  // Initialize collections/indexes before the import transaction.
  for (const model of [User, Workspace, WorkspaceMember, Project, ProjectVersion, ProjectMember, ScadaAsset, Connector, ConnectorEnvironment, ConnectorSecret, AuditEvent]) await model.init()
  await runMongoTransaction(async session => {
    const options = { session, upsert: true, setDefaultsOnInsert: true }
    const current = await Project.findById(project.id).select('+security.pinHash').session(session).lean()
    if (current && current.workspaceId !== project.workspaceId) throw new Error('Project belongs to another workspace.')
    const priorVersion = await ProjectVersion.findById(version.id).session(session).lean()
    if (priorVersion && (priorVersion.projectId !== project.id || priorVersion.checksum !== version.checksum)) throw new Error('An immutable version ID has conflicting content.')
    await User.updateOne({ _id: userId }, { $setOnInsert: { email: input.email, passwordHash, displayName: 'Runtime User', status: 'active', preferredWorkspaceId: project.workspaceId } }, options)
    await Workspace.updateOne({ _id: project.workspaceId }, { $setOnInsert: { name: `${project.name} runtime`, slug: deployment.deploymentId, ownerId: userId } }, options)
    await WorkspaceMember.updateOne({ workspaceId: project.workspaceId, userId }, { $set: { role: input.role }, $setOnInsert: { status: 'active' } }, options)
    await ProjectMember.updateOne({ projectId: project.id, userId }, { $set: { role: input.role }, $setOnInsert: { status: 'active' } }, options)
    for (const asset of assets) {
      const previous = await ScadaAsset.findById(asset._id).session(session).lean()
      if (previous && (previous.projectId !== project.id || previous.checksum !== asset.checksum)) throw new Error('An immutable asset ID has conflicting content.')
      await ScadaAsset.updateOne({ _id: asset._id }, { $setOnInsert: { ...asset, createdBy: userId } }, options)
    }
    await ProjectVersion.updateOne({ _id: version.id }, { $setOnInsert: { projectId: project.id, version: version.number, schema: version.schema, checksum: version.checksum, validationSummary: { issues: [] }, draftRevision: 1, idempotencyKey: `hosted-${version.id}`, environmentRef: version.schema.dataSources.find(source => source.type === 'thingsboard')?.environmentRef || 'production', assetId: version.schema.project.svgAssetId || null, assetChecksum: assets.find(asset => asset._id === version.schema.project.svgAssetId)?.checksum || null, createdBy: userId } }, options)
    for (const { connector, secret, metadata } of input.secrets) {
      await Connector.updateOne({ _id: connector.id }, { $set: { workspaceId: project.workspaceId, projectId: project.id, type: 'thingsboard', name: connector.id, enabled: true, updatedBy: userId }, $setOnInsert: { createdBy: userId } }, options)
      const old = await ConnectorEnvironment.findOne({ connectorId: connector.id, environmentRef: connector.environmentRef }).session(session).lean()
      await ConnectorEnvironment.updateOne({ connectorId: connector.id, environmentRef: connector.environmentRef }, { $set: { workspaceId: project.workspaceId, projectId: project.id, config: connector.config, updatedBy: userId }, $setOnInsert: { secretConfiguredAt: new Date(), authentication: metadata } }, options)
      // Redeploy never replaces a JWT that the running target has refreshed.
      if (!old?.secretConfiguredAt && secret) await ConnectorSecret.updateOne({ _id: connectorSecretId(connector.id, connector.environmentRef) }, { $setOnInsert: { connectorId: connector.id, environmentRef: connector.environmentRef, ...encryptConnectorSecret(secret, { connectorId: connector.id, environmentRef: connector.environmentRef }), rotatedBy: userId } }, options)
    }
    const security = current?.security?.pinEnabled ? current.security : { pinEnabled: project.pinRequired, pinHash, pinVersion: project.pinRequired ? 1 : 0 }
    await Project.updateOne({ _id: project.id }, { $set: { workspaceId: project.workspaceId, name: project.name, slug: project.slug, projectType: project.projectType, canvas: version.schema.project.canvas, svgAssetId: version.schema.project.svgAssetId || null, activeVersionId: version.id, lastVersionNumber: version.number, security, updatedBy: userId }, $setOnInsert: { createdBy: userId } }, options)
    await registry.updateOne({ _id: deployment.deploymentId }, { $set: { projectId: project.id, workspaceId: project.workspaceId, versionId: version.id, payloadChecksum: deployment.payloadChecksum, importedAt: new Date() } }, { session, upsert: true })
    await AuditEvent.create([{ workspaceId: project.workspaceId, projectId: project.id, actorId: userId, action: 'runtime.deployment.imported', targetType: 'version', targetId: version.id, metadata: { deploymentId: deployment.deploymentId, checksum: deployment.payloadChecksum, sourceChecksum: version.sourceChecksum } }], { session })
  }, { requireTransaction: true })
}

export function deploymentProvisioner(deployment) {
  let pending
  return () => pending ||= provisionDeployment(deployment).catch(error => { pending = null; throw error })
}
