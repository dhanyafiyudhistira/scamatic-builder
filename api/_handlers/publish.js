import { createHash, randomUUID } from 'node:crypto'
import { connectMongo, runMongoTransaction } from '../_lib/mongo.js'
import { AuditEvent, Connector, ConnectorEnvironment, Project, ProjectDraft, ProjectVersion, ScadaAsset } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { enforceRateLimit, requestId } from '../_lib/security.js'
import { hasBlockingIssues, migrateProjectSchema, validateProjectSchema } from '../../shared/project-schema.js'
import { runtimeProfile } from '../../shared/runtime-profile.js'
import { connectorEnvironmentReadiness, connectorExecutionMode } from '../_lib/connector-execution.js'
import { DESIGN_IMAGE_TYPE, referencedDesignAssetIds } from '../_lib/design-assets.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  if (!requireCsrf(req, res, principal)) return
  const { projectId, expectedDraftRevision, idempotencyKey = randomUUID(), message = 'Published from builder' } = req.body || {}
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' })
  if (!(await enforceRateLimit(req, res, 'publish', { limit: 20, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return
  if (!validKey(idempotencyKey)) return res.status(400).json({ error: 'A valid idempotencyKey is required.' })
  if (!Number.isInteger(Number(expectedDraftRevision))) return res.status(400).json({ error: 'expectedDraftRevision is required.' })
  const correlationId = requestId(req)

  try {
    await connectMongo()
    const project = await Project.findById(projectId)
    if (!project || !(await requireProjectPermission(principal, res, project, PERMISSIONS.PROJECT_PUBLISH))) return
    const existing = await ProjectVersion.findOne({ projectId, idempotencyKey }).lean()
    if (existing) return res.status(200).json(toResponse(project, existing, true))

    const latestVersion = await ProjectVersion.findOne({ projectId }).sort({ version: -1 }).select({ version: 1 }).lean()
    if ((project.lastVersionNumber || 0) < (latestVersion?.version || 0)) {
      project.lastVersionNumber = latestVersion.version
      await project.save()
    }

    const draft = await ProjectDraft.findById(projectId).lean()
    if (!draft) return res.status(404).json({ error: 'Project draft not found.' })
    if (draft.revision !== Number(expectedDraftRevision)) return res.status(409).json({ error: 'Draft changed before publish. Validate the latest revision.', code: 'DRAFT_CONFLICT', currentRevision: draft.revision })
    const migratedDraft = migrateProjectSchema(draft.schema)
    const issues = validateProjectSchema(migratedDraft, { requireAsset: true })
    if (hasBlockingIssues(issues)) return res.status(422).json({ error: 'Publish validation failed.', issues })
    const connectorIssues = await validateConnectorReadiness(migratedDraft, project, principal.workspaceId)
    if (connectorIssues.length) return res.status(422).json({ error: 'Connector readiness validation failed.', code: 'CONNECTOR_NOT_READY', issues: connectorIssues })
    const asset = await ScadaAsset.findOne({ _id: migratedDraft.project.svgAssetId, projectId }).lean()
    if (!asset) return res.status(422).json({ error: 'Sanitized SVG asset is missing.', issues })
    const designAssetIds = referencedDesignAssetIds(migratedDraft)
    if (designAssetIds.length) {
      const storedDesignAssetIds = await ScadaAsset.find({ _id: { $in: designAssetIds }, projectId, kind: DESIGN_IMAGE_TYPE }).distinct('_id')
      const missing = designAssetIds.filter(id => !storedDesignAssetIds.map(String).includes(id))
      if (missing.length) return res.status(422).json({
        error: 'One or more design elements are missing.',
        issues: [...issues, { severity: 'error', code: 'designAsset.missing', message: 'Upload the missing design element again before publishing.', path: 'components' }],
      })
    }

    const version = await runMongoTransaction(async session => {
      const options = session ? { session } : {}
      const currentDraft = await ProjectDraft.findById(projectId, null, options).lean()
      if (!currentDraft || currentDraft.revision !== Number(expectedDraftRevision)) {
        const error = new Error('DRAFT_CONFLICT'); error.code = 'DRAFT_CONFLICT'; error.currentRevision = currentDraft?.revision; throw error
      }
      const allocated = await Project.findOneAndUpdate(
        { _id: projectId, workspaceId: principal.workspaceId },
        { $inc: { lastVersionNumber: 1 }, $set: { updatedBy: principal.id } },
        { new: true, ...options }
      )
      const snapshot = migrateProjectSchema(currentDraft.schema)
      const checksum = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
      const [created] = await ProjectVersion.create([{
        projectId,
        version: allocated.lastVersionNumber,
        schema: snapshot,
        checksum,
        validationSummary: { issues, validatedAt: new Date().toISOString() },
        idempotencyKey,
        message: String(message).trim().slice(0, 200),
        draftRevision: currentDraft.revision,
        assetId: asset._id,
        assetChecksum: asset.checksum,
        environmentRef: publishedEnvironmentRef(snapshot),
        createdBy: principal.id,
      }], options)
      await Project.updateOne({ _id: projectId }, { $set: { activeVersionId: created.id, updatedBy: principal.id } }, options)
      await AuditEvent.create([{ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.publish', targetType: 'version', targetId: created.id, correlationId, metadata: { version: created.version, checksum, draftRevision: currentDraft.revision } }], options)
      return created.toObject()
    })
    return res.status(201).json(toResponse(project, version, false))
  } catch (error) {
    if (error.code === 'DRAFT_CONFLICT') return res.status(409).json({ error: 'Draft changed during publish.', code: 'DRAFT_CONFLICT', currentRevision: error.currentRevision })
    if (error.code === 11000) {
      const existing = await ProjectVersion.findOne({ projectId, idempotencyKey }).lean()
      if (existing) return res.status(200).json(toResponse({ slug: '' }, existing, true))
    }
    await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.publish.failed', targetType: 'project', targetId: projectId, correlationId, metadata: { reason: String(error.code || 'INTERNAL').slice(0, 80) } }).catch(() => {})
    return res.status(500).json({ error: 'Unable to publish project.', correlationId })
  }
}

function validKey(value) { return /^[a-zA-Z0-9_-]{8,100}$/.test(String(value || '')) }
function toResponse(project, version, replayed) { return { ok: true, replayed, version: version.version, versionId: version._id, checksum: version.checksum, issues: version.validationSummary?.issues || [], runtimePath: project.slug ? `/runtime/${project.slug}` : null } }

export function publishedEnvironmentRef(schema) {
  const liveSource = (schema?.dataSources || []).find(source => source?.type && source.type !== 'mock')
  return liveSource?.environmentRef || 'mock'
}

async function validateConnectorReadiness(schema, project, workspaceId) {
  if (runtimeProfile(schema) === 'simulation') return []
  const sources = (schema.dataSources || []).filter(source => source.type !== 'mock')
  if (!sources.length) return []
  if (process.env.CONNECTOR_PLATFORM_ENABLED !== 'true') return [{ severity: 'error', code: 'connector.feature_disabled', message: 'Connector platform feature flag is disabled.', path: 'dataSources' }]
  const executionMode = connectorExecutionMode()
  const issues = []
  for (const source of sources) {
    const connector = await Connector.findOne({ _id: source.connectorRef, projectId: project.id, workspaceId, enabled: true }).lean()
    if (!connector || connector.type !== source.type) {
      issues.push({ severity: 'error', code: 'connector.missing', message: `Connector for source ${source.id} is unavailable.`, path: `dataSources.${source.id}` })
      continue
    }
    const environment = await ConnectorEnvironment.findOne({ connectorId: connector._id, environmentRef: source.environmentRef || 'staging' }).lean()
    const readiness = connectorEnvironmentReadiness(environment, { executionMode })
    if (!readiness.ready) {
      const requirement = executionMode === 'serverless'
        ? 'is not configured and online'
        : 'does not have a fresh online worker heartbeat'
      issues.push({ severity: 'error', code: 'connector.unhealthy', message: `Connector ${connector.name} ${requirement} in ${source.environmentRef || 'staging'}.`, path: `dataSources.${source.id}` })
    }
  }
  return issues
}
