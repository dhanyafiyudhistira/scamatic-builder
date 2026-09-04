import { connectMongo } from '../_lib/mongo.js'
import { AuditEvent, Connector, ConnectorEnvironment, ConnectorHealthEvent, ConnectorSecret, Project, ProjectDraft } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission, roleCan } from '../_lib/authorization.js'
import { connectorSecretId, decryptConnectorSecret, encryptConnectorSecret } from '../_lib/connector-secrets.js'
import { assertSafeConnectorTarget, normalizeConnectorServerUrl } from '../_lib/connector-target.js'
import { publicConnector } from '../../shared/connector-contract.js'
import { enforceRateLimit, redactMetadata, requestId } from '../_lib/security.js'
import { usesServerlessConnectorExecution } from '../_lib/connector-execution.js'
import { loginThingsBoardAccount, mergeThingsBoardSecret, thingsBoardAuthenticationMetadata, withThingsBoardAccessToken } from '../_lib/thingsboard-auth.js'
import { connectorDeletionBlock } from '../../shared/connector-lifecycle.js'

const ENVIRONMENTS = new Set(['development', 'staging', 'production'])

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  const projectId = String(req.query?.projectId || req.body?.projectId || '')
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' })

  await connectMongo()
  const project = await Project.findById(projectId)
  const permission = req.method === 'GET' ? PERMISSIONS.BUILDER_READ : PERMISSIONS.SOURCE_CONFIGURE
  if (!project || !(await requireProjectPermission(principal, res, project, permission))) return
  if (req.method !== 'GET' && !requireCsrf(req, res, principal)) return
  const rateScope = req.method === 'GET' ? 'connector-read' : 'connector-write'
  const rateLimit = req.method === 'GET' ? 120 : 40
  if (!(await enforceRateLimit(req, res, rateScope, { limit: rateLimit, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return

  try {
    if (req.method === 'GET') return listConnectors(res, principal, projectId, req.query?.environmentRef)
    if (req.method === 'POST' && req.body?.action) return connectorAction(req, res, principal, projectId)
    if (req.method === 'POST') return createConnector(req, res, principal, projectId)
    if (req.method === 'PUT') return updateConnector(req, res, principal, projectId)
    if (req.method === 'DELETE') return deleteConnector(req, res, principal, projectId)
    res.setHeader('Allow', 'GET, POST, PUT, DELETE')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  } catch (error) {
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message })
    return res.status(500).json({ error: 'Unable to process connector request.', code: 'CONNECTOR_REQUEST_FAILED', correlationId: requestId(req) })
  }
}

async function listConnectors(res, principal, projectId, environmentRef = 'staging') {
  const environment = validEnvironment(environmentRef)
  const connectors = await Connector.find({ workspaceId: principal.workspaceId, projectId }).sort({ createdAt: 1 }).lean()
  const environments = await ConnectorEnvironment.find({ connectorId: { $in: connectors.map(item => item._id) }, environmentRef: environment }).lean()
  const byConnector = new Map(environments.map(item => [item.connectorId, item]))
  return res.status(200).json({ connectors: connectors.map(item => publicConnector(item, byConnector.get(item._id))), environmentRef: environment })
}

async function createConnector(req, res, principal, projectId) {
  const name = String(req.body?.name || '').trim()
  const type = String(req.body?.type || '')
  const environmentRef = validEnvironment(req.body?.environmentRef || 'staging')
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Connector name must contain 2–80 characters.' })
  if (type !== 'thingsboard') return res.status(400).json({ error: 'The first vertical slice supports only ThingsBoard.' })
  const config = sanitizeThingsBoardConfig(req.body?.config)
  try {
    const connector = await Connector.create({ workspaceId: principal.workspaceId, projectId, name, type, enabled: false, createdBy: principal.id, updatedBy: principal.id })
    const connectorEnvironment = await ConnectorEnvironment.create({ connectorId: connector.id, workspaceId: principal.workspaceId, projectId, environmentRef, config, updatedBy: principal.id })
    await audit(principal, projectId, 'connector.create', connector.id, { type, environmentRef })
    return res.status(201).json({ connector: publicConnector(connector.toObject(), connectorEnvironment.toObject()) })
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'A connector with this name already exists.' })
    throw error
  }
}

async function updateConnector(req, res, principal, projectId) {
  const connector = await ownedConnector(req.body?.connectorId, principal, projectId)
  if (!connector) return res.status(404).json({ error: 'Connector not found.' })
  const environmentRef = validEnvironment(req.body?.environmentRef || 'staging')
  const name = req.body?.name == null ? connector.name : String(req.body.name).trim()
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Connector name must contain 2–80 characters.' })
  connector.name = name
  connector.enabled = Boolean(req.body?.enabled)
  connector.updatedBy = principal.id
  await connector.save()
  const environment = await ConnectorEnvironment.findOneAndUpdate(
    { connectorId: connector.id, environmentRef },
    { $set: { config: sanitizeThingsBoardConfig(req.body?.config), updatedBy: principal.id }, $setOnInsert: { workspaceId: principal.workspaceId, projectId } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
  await audit(principal, projectId, 'connector.update', connector.id, { environmentRef, enabled: connector.enabled })
  return res.status(200).json({ connector: publicConnector(connector.toObject(), environment.toObject()) })
}

async function connectorAction(req, res, principal, projectId) {
  const connector = await ownedConnector(req.body?.connectorId, principal, projectId)
  if (!connector) return res.status(404).json({ error: 'Connector not found.' })
  const environmentRef = validEnvironment(req.body?.environmentRef || 'staging')
  const environment = await ConnectorEnvironment.findOne({ connectorId: connector.id, environmentRef })
  if (!environment) return res.status(404).json({ error: 'Connector environment not found.' })
  const action = String(req.body.action)
  if (['rotate-secret', 'connect-account', 'test'].includes(action) && !(await enforceRateLimit(req, res, `connector-${action}`, { limit: action === 'connect-account' ? 5 : 8, windowMs: 60_000, identity: `${principal.id}:${projectId}:${connector.id}` }))) return
  if (action === 'connect-account') {
    if (!roleCan(principal.role, PERMISSIONS.SECRET_ROTATE)) return res.status(403).json({ error: 'Insufficient permission.', code: 'PERMISSION_DENIED' })
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    if (username.length < 3 || username.length > 320 || password.length < 1 || password.length > 1_024) {
      return res.status(400).json({ error: 'Valid ThingsBoard account credentials are required.' })
    }
    let pair
    try {
      pair = await loginThingsBoardAccount({ serverUrl: environment.config?.serverUrl, username, password })
    } catch {
      await audit(principal, projectId, 'connector.account.connect.failed', connector.id, { environmentRef })
      return res.status(422).json({ error: 'ThingsBoard rejected the account connection.', code: 'THINGSBOARD_LOGIN_FAILED' })
    }
    const secretId = connectorSecretId(connector.id, environmentRef)
    const currentRecord = await ConnectorSecret.findById(secretId).select('+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion').lean()
    const currentSecret = currentRecord ? decryptConnectorSecret(currentRecord, { connectorId: connector.id, environmentRef }) : {}
    const nextSecret = {
      ...(currentSecret.deviceToken ? { deviceToken: currentSecret.deviceToken } : {}),
      jwt: pair.token,
      refreshToken: pair.refreshToken,
    }
    const encrypted = encryptConnectorSecret(nextSecret, { connectorId: connector.id, environmentRef })
    const connectedAt = new Date()
    await ConnectorSecret.findOneAndUpdate(
      { _id: secretId },
      { $set: { connectorId: connector.id, environmentRef, ...encrypted, rotatedBy: principal.id } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    environment.authentication = thingsBoardAuthenticationMetadata(nextSecret, { now: connectedAt })
    environment.secretConfiguredAt = connectedAt
    environment.health = usesServerlessConnectorExecution()
      ? { state: 'degraded', message: 'ThingsBoard account connected; run a connection test.', checkedAt: connectedAt }
      : { state: 'offline', message: 'ThingsBoard account connected; waiting for worker.', checkedAt: connectedAt }
    environment.updatedBy = principal.id
    await environment.save()
    await audit(principal, projectId, 'connector.account.connected', connector.id, { environmentRef, autoRefresh: true })
    return res.status(200).json({ connector: publicConnector(connector.toObject(), environment.toObject()) })
  }
  if (action === 'rotate-secret') {
    if (!roleCan(principal.role, PERMISSIONS.SECRET_ROTATE)) return res.status(403).json({ error: 'Insufficient permission.', code: 'PERMISSION_DENIED' })
    const jwtInput = req.body?.secret?.jwt
    const refreshTokenInput = req.body?.secret?.refreshToken
    const deviceTokenInput = req.body?.secret?.deviceToken
    if (jwtInput == null && refreshTokenInput == null && deviceTokenInput == null) return res.status(400).json({ error: 'A ThingsBoard JWT, refresh token, or device access token is required.' })
    if (refreshTokenInput != null && jwtInput == null) return res.status(400).json({ error: 'A refresh token must be rotated together with its access JWT.' })
    const jwt = jwtInput == null ? null : String(jwtInput).trim()
    const refreshToken = refreshTokenInput == null ? null : String(refreshTokenInput).trim()
    const deviceToken = deviceTokenInput == null ? null : String(deviceTokenInput).trim()
    if (jwt != null && (jwt.length < 16 || jwt.length > 16_384)) return res.status(400).json({ error: 'A valid ThingsBoard JWT is required.' })
    if (refreshToken != null && (refreshToken.length < 16 || refreshToken.length > 16_384)) return res.status(400).json({ error: 'A valid ThingsBoard refresh token is required.' })
    if (deviceToken != null && (deviceToken.length < 8 || deviceToken.length > 512 || /[\s/]/.test(deviceToken))) return res.status(400).json({ error: 'A valid ThingsBoard device access token is required.' })
    const secretId = connectorSecretId(connector.id, environmentRef)
    const currentRecord = await ConnectorSecret.findById(secretId).select('+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion').lean()
    const currentSecret = currentRecord ? decryptConnectorSecret(currentRecord, { connectorId: connector.id, environmentRef }) : {}
    const nextSecret = mergeThingsBoardSecret(currentSecret, { jwt, refreshToken, deviceToken })
    const encrypted = encryptConnectorSecret(nextSecret, { connectorId: connector.id, environmentRef })
    const rotatedAt = new Date()
    await ConnectorSecret.findOneAndUpdate(
      { _id: secretId },
      { $set: { connectorId: connector.id, environmentRef, ...encrypted, rotatedBy: principal.id } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
    if (jwt != null || refreshToken != null) {
      environment.secretConfiguredAt = rotatedAt
      environment.authentication = thingsBoardAuthenticationMetadata(nextSecret, { now: rotatedAt })
      environment.health = usesServerlessConnectorExecution()
        ? { state: 'degraded', message: 'JWT rotated; run a connection test.', checkedAt: rotatedAt }
        : { state: 'offline', message: 'JWT rotated; waiting for worker.', checkedAt: rotatedAt }
    }
    if (deviceToken != null) environment.deviceTokenConfiguredAt = rotatedAt
    environment.updatedBy = principal.id
    await environment.save()
    await audit(principal, projectId, 'connector.secret.rotated', connector.id, { environmentRef, jwt: jwt != null, refreshToken: refreshToken != null, simulationDeviceToken: deviceToken != null })
    return res.status(200).json({ connector: publicConnector(connector.toObject(), environment.toObject()) })
  }
  if (action === 'test') {
    const result = await testConnection(connector, environment)
    const serverless = usesServerlessConnectorExecution()
    const workerFresh = !serverless && environment.health?.state === 'online' && environment.health?.checkedAt && Date.now() - new Date(environment.health.checkedAt).getTime() < 45_000
    const previousHealth = environment.health?.toObject?.() || environment.health || {}
    environment.health = {
      ...previousHealth,
      state: result.ok ? (serverless || workerFresh ? 'online' : 'degraded') : 'error',
      message: result.ok && !serverless && !workerFresh ? `${result.message} Waiting for worker heartbeat.` : result.message,
      checkedAt: new Date(),
      ...(result.ok && (serverless || workerFresh) ? { connectedAt: previousHealth.connectedAt || new Date() } : {}),
    }
    await environment.save()
    await ConnectorHealthEvent.create({ connectorId: connector.id, workspaceId: principal.workspaceId, projectId, environmentRef, state: environment.health.state, message: environment.health.message })
    await audit(principal, projectId, result.ok ? 'connector.test.succeeded' : 'connector.test.failed', connector.id, { environmentRef, code: result.code })
    return res.status(result.ok ? 200 : 422).json({ ok: result.ok, message: result.message, connector: publicConnector(connector.toObject(), environment.toObject()) })
  }
  return res.status(400).json({ error: 'Unsupported connector action.' })
}

async function deleteConnector(req, res, principal, projectId) {
  const connector = await ownedConnector(req.query?.connectorId || req.body?.connectorId, principal, projectId)
  if (!connector) return res.status(404).json({ error: 'Connector not found.' })
  const draftReference = await ProjectDraft.exists({ _id: projectId, 'schema.dataSources.connectorRef': connector.id })
  const deletionBlock = connectorDeletionBlock({ enabled: connector.enabled, draftAttached: Boolean(draftReference) })
  if (deletionBlock) return res.status(409).json({ error: deletionBlock.message, code: deletionBlock.code })
  await Promise.all([
    ConnectorEnvironment.deleteMany({ connectorId: connector.id }),
    ConnectorSecret.deleteMany({ connectorId: connector.id }),
    ConnectorHealthEvent.deleteMany({ connectorId: connector.id }),
  ])
  await connector.deleteOne()
  await audit(principal, projectId, 'connector.delete', connector.id, { type: connector.type, publishedHistoryPreserved: true })
  return res.status(200).json({ ok: true, publishedHistoryPreserved: true })
}

async function testConnection(connector, environment) {
  try {
    const serverUrl = await assertSafeConnectorTarget(environment.config.serverUrl)
    const response = await withThingsBoardAccessToken(
      { connectorId: connector.id, environmentRef: environment.environmentRef },
      jwt => fetch(`${serverUrl}/api/auth/user`, { headers: { 'X-Authorization': `Bearer ${jwt}` }, redirect: 'manual', signal: AbortSignal.timeout(8_000) }),
    )
    if (!response.ok) return { ok: false, code: `HTTP_${response.status}`, message: 'ThingsBoard rejected the connector credentials.' }
    return { ok: true, code: 'OK', message: 'ThingsBoard connection succeeded.' }
  } catch (error) {
    return { ok: false, code: String(error.code || error.name || 'CONNECT_FAILED').slice(0, 80), message: 'ThingsBoard connection failed.' }
  }
}

export function sanitizeThingsBoardConfig(input = {}) {
  const serverUrl = normalizeConnectorServerUrl(input?.serverUrl)
  const deviceId = String(input?.deviceId || '').trim()
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(deviceId)) throw Object.assign(new Error('A valid ThingsBoard deviceId is required.'), { statusCode: 400 })
  return { serverUrl, deviceId, rpcMode: input?.rpcMode === 'two-way' ? 'two-way' : 'feedback-tag', commandTimeoutMs: boundedNumber(input?.commandTimeoutMs, 1000, 30000, 5000) }
}

function validEnvironment(value) {
  const environment = String(value || 'staging')
  if (!ENVIRONMENTS.has(environment)) throw Object.assign(new Error('Invalid connector environment.'), { statusCode: 400 })
  return environment
}
async function ownedConnector(id, principal, projectId) { return Connector.findOne({ _id: String(id || ''), workspaceId: principal.workspaceId, projectId }) }
function boundedNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback }
function audit(principal, projectId, action, targetId, metadata) { return AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action, targetType: 'connector', targetId, correlationId: null, metadata: redactMetadata(metadata) }) }
