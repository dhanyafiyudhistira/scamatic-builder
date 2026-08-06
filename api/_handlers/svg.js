import { createHash } from 'node:crypto'
import { connectMongo } from '../_lib/mongo.js'
import { AuditEvent, Project, ProjectDraft, ScadaAsset } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { enforceRateLimit } from '../_lib/security.js'
import { sanitizeSvg } from '../_lib/svg.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }

  const { projectId, svg } = req.body || {}
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' })
  if (!requireCsrf(req, res, principal)) return
  if (!(await enforceRateLimit(req, res, 'svg-upload', { limit: 10, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return
  try {
    const clean = sanitizeSvg(svg)
    await connectMongo()
    const project = await Project.findById(projectId)
    const draft = await ProjectDraft.findById(projectId)
    if (!project || !draft) return res.status(404).json({ error: 'Project not found.' })
    if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.BUILDER_WRITE))) return

    const checksum = createHash('sha256').update(clean.svg).digest('hex')
    const asset = await ScadaAsset.create({
      projectId,
      content: clean.svg,
      checksum,
      byteLength: clean.byteLength,
      metadata: { viewBox: clean.viewBox, width: clean.width, height: clean.height },
      createdBy: principal.id,
    })
    draft.schema.project.svgAssetId = asset.id
    draft.markModified('schema')
    draft.revision += 1
    draft.updatedBy = principal.id
    await draft.save()
    project.svgAssetId = asset.id
    project.updatedBy = principal.id
    await project.save()
    await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'asset.svg.upload', targetType: 'asset', targetId: asset.id, metadata: { checksum, byteLength: clean.byteLength } })
    return res.status(201).json({ assetId: asset.id, svg: clean.svg, revision: draft.revision, metadata: asset.metadata })
  } catch (error) {
    const clientError = /SVG|File/.test(error.message)
    return res.status(clientError ? 422 : 500).json({ error: clientError ? error.message : 'Unable to store SVG asset.' })
  }
}
