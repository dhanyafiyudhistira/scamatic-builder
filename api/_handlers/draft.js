import { connectMongo } from '../_lib/mongo.js'
import { Project, ProjectDraft, ScadaAsset } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { hasBlockingIssues, migrateProjectSchema, validateProjectSchema } from '../../shared/project-schema.js'
import { DESIGN_IMAGE_TYPE, publicDesignAssets, referencedDesignAssetIds } from '../_lib/design-assets.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  const projectId = String(req.query?.projectId || req.body?.projectId || '')
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' })

  try {
    await connectMongo()
    const project = await Project.findById(projectId).lean()
    if (!project) return res.status(404).json({ error: 'Project not found.' })

    if (req.method === 'GET') {
      if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.BUILDER_READ))) return
      const draft = await ProjectDraft.findById(projectId).lean()
      if (!draft) return res.status(404).json({ error: 'Project draft not found.' })
      const asset = project.svgAssetId ? await ScadaAsset.findById(project.svgAssetId).lean() : null
      const schema = migrateProjectSchema(draft.schema)
      const designAssetIds = referencedDesignAssetIds(schema)
      const designAssetRecords = designAssetIds.length
        ? await ScadaAsset.find({ _id: { $in: designAssetIds }, projectId, kind: DESIGN_IMAGE_TYPE }).select({ content: 0 }).lean()
        : []
      return res.status(200).json({ schema, revision: draft.revision, svg: asset?.content || null, designAssets: publicDesignAssets(designAssetRecords) })
    }

    if (req.method === 'PUT') {
      if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.BUILDER_WRITE)) || !requireCsrf(req, res, principal)) return
      const { schema: inputSchema, revision } = req.body || {}
      const schema = migrateProjectSchema(inputSchema)
      if (schema?.project?.id !== projectId) return res.status(400).json({ error: 'Schema project id does not match projectId.' })
      const issues = validateProjectSchema(schema)
      if (hasBlockingIssues(issues)) return res.status(422).json({ error: 'Draft schema is invalid.', issues })
      const currentRevision = Number(revision)
      if (!Number.isInteger(currentRevision) || currentRevision < 1) return res.status(400).json({ error: 'A valid draft revision is required.' })

      const updated = await ProjectDraft.findOneAndUpdate(
        { _id: projectId, revision: currentRevision },
        { $set: { schema, updatedBy: principal.id }, $inc: { revision: 1 } },
        { new: true }
      ).lean()
      if (!updated) return res.status(409).json({ error: 'Draft changed on the server. Reload before saving again.', code: 'DRAFT_CONFLICT' })
      await Project.findByIdAndUpdate(projectId, { updatedBy: principal.id })
      return res.status(200).json({ ok: true, revision: updated.revision, issues })
    }

    res.setHeader('Allow', 'GET, PUT')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  } catch {
    return res.status(500).json({ error: 'Unable to load or save project draft.' })
  }
}
