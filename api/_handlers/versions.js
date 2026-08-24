import { createHash, randomUUID } from 'node:crypto'
import { connectMongo, runMongoTransaction } from '../_lib/mongo.js'
import { AuditEvent, Project, ProjectVersion, ScadaAsset } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { requestId } from '../_lib/security.js'
import { migrateProjectSchema } from '../../shared/project-schema.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  const projectId = String(req.query?.projectId || req.body?.projectId || '')
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' })
  await connectMongo()
  const project = await Project.findById(projectId)
  if (!project) return res.status(404).json({ error: 'Project not found.' })

  if (req.method === 'GET') {
    if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.BUILDER_READ))) return
    const versions = await ProjectVersion.find({ projectId }).sort({ version: -1 }).select({ schema: 0 }).limit(100).lean()
    return res.status(200).json({ activeVersionId: project.activeVersionId, versions: versions.map(publicVersion) })
  }

  if (req.method === 'POST') {
    if (!requireCsrf(req, res, principal) || !(await requireProjectPermission(principal, res, project, PERMISSIONS.PROJECT_PUBLISH))) return
    const sourceVersionId = String(req.body?.versionId || '')
    const idempotencyKey = String(req.body?.idempotencyKey || randomUUID())
    if (!sourceVersionId || !/^[a-zA-Z0-9_-]{8,100}$/.test(idempotencyKey)) return res.status(400).json({ error: 'versionId and idempotencyKey are required.' })
    const previous = await ProjectVersion.findOne({ _id: sourceVersionId, projectId }).lean()
    if (!previous) return res.status(404).json({ error: 'Version not found.' })
    const sourceAssetId = previous.assetId || previous.schema?.project?.svgAssetId
    const asset = await ScadaAsset.findOne({ _id: sourceAssetId, projectId }).lean()
    if (!asset || (previous.assetChecksum && asset.checksum !== previous.assetChecksum)) return res.status(409).json({ error: 'Version asset integrity check failed.', code: 'ASSET_MISMATCH' })
    const existing = await ProjectVersion.findOne({ projectId, idempotencyKey }).lean()
    if (existing) return res.status(200).json({ ok: true, replayed: true, version: publicVersion(existing) })
    const latestVersion = await ProjectVersion.findOne({ projectId }).sort({ version: -1 }).select({ version: 1 }).lean()
    if ((project.lastVersionNumber || 0) < (latestVersion?.version || 0)) {
      project.lastVersionNumber = latestVersion.version
      await project.save()
    }
    const correlationId = requestId(req)
    const restored = await runMongoTransaction(async session => {
      const options = session ? { session } : {}
      const allocated = await Project.findOneAndUpdate({ _id: projectId }, { $inc: { lastVersionNumber: 1 }, $set: { updatedBy: principal.id } }, { new: true, ...options })
      const snapshot = migrateProjectSchema(previous.schema)
      const checksum = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
      const [created] = await ProjectVersion.create([{ projectId, version: allocated.lastVersionNumber, schema: snapshot, checksum, validationSummary: previous.validationSummary || { issues: [] }, idempotencyKey, message: String(req.body?.message || `Restored from v${previous.version}`).slice(0, 200), draftRevision: previous.draftRevision || 1, assetId: sourceAssetId, assetChecksum: asset.checksum, restoredFromVersionId: previous._id, restoredFromVersion: previous.version, environmentRef: previous.environmentRef || 'mock', createdBy: principal.id }], options)
      await Project.updateOne({ _id: projectId }, { $set: { activeVersionId: created.id } }, options)
      await AuditEvent.create([{ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.rollback', targetType: 'version', targetId: created.id, correlationId, metadata: { version: created.version, restoredFromVersion: previous.version } }], options)
      return created.toObject()
    })
    return res.status(201).json({ ok: true, replayed: false, version: publicVersion(restored) })
  }
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: `Method ${req.method} not allowed` })
}

function publicVersion(version) { return { id: version._id, version: version.version, checksum: version.checksum, message: version.message, draftRevision: version.draftRevision, restoredFromVersionId: version.restoredFromVersionId, restoredFromVersion: version.restoredFromVersion, environmentRef: version.environmentRef, createdBy: version.createdBy, createdAt: version.createdAt } }
