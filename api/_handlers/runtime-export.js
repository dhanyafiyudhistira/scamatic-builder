import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectMongo } from '../_lib/mongo.js'
import { requirePrincipal, requireCsrf } from '../_lib/auth.js'
import { requireProjectPermission, PERMISSIONS } from '../_lib/authorization.js'
import { enforceRateLimit } from '../_lib/security.js'
import { Project, ProjectDraft, ProjectVersion, ScadaAsset, Connector, ConnectorEnvironment, AuditEvent } from '../_lib/models.js'
import { createDeployment } from '../../hosted-runtime/contract.js'
import { exportRuntimePackage } from '../../hosted-runtime/export-package.js'
import { referencedDesignAssetIds } from '../_lib/design-assets.js'
import { runtimeProfile } from '../../shared/runtime-profile.js'
import { projectOutputTarget, WINCC_OUTPUT_TARGET } from '../../shared/project-type.js'
import { exportWinccPackage } from '../_lib/wincc-export.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST to export a runtime package.' })
  if (!requireCsrf(req, res, principal)) return
  if (!(await enforceRateLimit(req, res, 'runtime-export', { limit: 5, windowMs: 60_000, identity: principal.id }))) return
  const projectId = String(req.body?.projectId || '')
  const target = String(req.body?.target || 'node')
  if (!['node', 'vercel', WINCC_OUTPUT_TARGET].includes(target)) return res.status(400).json({ error: 'Unknown export target.' })
  try {
    await connectMongo()
    const project = await Project.findById(projectId).lean()
    if (!project) return res.status(404).json({ error: 'Project not found.' })
    if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.PROJECT_MANAGE))) return
    if (target === WINCC_OUTPUT_TARGET) return await exportWinccDraft(req, res, project, principal)
    if (!project.activeVersionId) return res.status(409).json({ error: 'Publish a SCADA or IoT Dashboard version before exporting.' })
    const version = await ProjectVersion.findById(project.activeVersionId).lean()
    const assetIds = [...new Set([...referencedDesignAssetIds(version?.schema), version?.schema?.project?.svgAssetId].filter(Boolean))]
    const assets = await ScadaAsset.find({ projectId, _id: { $in: assetIds } }).lean()
    const connectors = []
    for (const source of version?.schema?.dataSources || []) {
      if (runtimeProfile(version.schema) === 'simulation' || source.type !== 'thingsboard') continue
      const environmentRef = source.environmentRef || 'staging'
      const connector = await Connector.findOne({ _id: source.connectorRef, workspaceId: principal.workspaceId, projectId }).lean()
      const environment = connector && await ConnectorEnvironment.findOne({ connectorId: connector._id, workspaceId: principal.workspaceId, projectId, environmentRef }).select({ config: 1 }).lean()
      if (environment) connectors.push({ id: String(connector._id), environmentRef, config: environment.config })
    }
    const deployment = createDeployment({ project, version, assets, connectors })
    const exported = exportRuntimePackage(root, deployment, target)
    await AuditEvent.create({ actorId: principal.id, workspaceId: principal.workspaceId, projectId, action: 'project.runtime.exported', targetType: 'version', targetId: version._id, metadata: { target, sha256: exported.sha256, policy: exported.policy, sourceChecksum: version.checksum } })
    res.setHeader('Cache-Control', 'no-store')
    return res.json(exported)
  } catch (error) {
    const missingBuild = error.code === 'ENOENT'
    const checksumMismatch = error.code === 'PUBLISHED_SCHEMA_CHECKSUM_MISMATCH'
    return res.status(missingBuild ? 503 : checksumMismatch ? 409 : 422).json({ error: missingBuild ? 'Hosted runtime build inputs are unavailable. Use the latest local installer.' : error.message, code: checksumMismatch ? error.code : undefined, issues: error.issues || [] })
  }
}

async function exportWinccDraft(req, res, project, principal) {
  if (projectOutputTarget(project) !== WINCC_OUTPUT_TARGET) {
    return res.status(422).json({ error: 'Choose the WinCC Unified target when creating the SCADA project.' })
  }
  const revision = req.body?.revision
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return res.status(400).json({ error: 'A saved draft revision is required.' })
  }
  const draft = await ProjectDraft.findById(project._id).select({ schema: 1, revision: 1 }).lean()
  if (!draft || draft.revision !== revision) {
    return res.status(409).json({ error: 'The saved draft has changed. Reopen it before exporting.', code: 'DRAFT_CONFLICT' })
  }
  const assetId = draft.schema?.project?.svgAssetId
  const schematic = assetId
    ? await ScadaAsset.findOne({ _id: assetId, projectId: project._id }).select({ content: 1 }).lean()
    : null
  const result = exportWinccPackage({ schema: draft.schema, revision, schematic: schematic?.content })
  await AuditEvent.create({
    actorId: principal.id,
    workspaceId: principal.workspaceId,
    projectId: project._id,
    action: 'project.wincc.exported',
    targetType: 'project',
    targetId: project._id,
    metadata: { revision, componentCount: result.componentCount, graphicCount: result.graphicCount },
  })
  res.setHeader('Cache-Control', 'no-store')
  return res.json(result)
}
