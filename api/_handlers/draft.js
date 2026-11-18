import { connectMongo } from '../_lib/mongo.js'
import { Project, ProjectDraft, ScadaAsset } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { hasBlockingIssues, migrateProjectSchema, validateProjectSchema } from '../../shared/project-schema.js'
import { WINCC_OUTPUT_TARGET, projectOutputTarget } from '../../shared/project-type.js'
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
      const [data, asset] = await Promise.all([
        loadDraftWithDesignAssets(projectId),
        project.svgAssetId ? ScadaAsset.findById(project.svgAssetId).select({ content: 1 }).lean().exec() : null,
      ])
      if (!data) return res.status(404).json({ error: 'Project draft not found.' })
      return res.status(200).json({ ...data, svg: asset?.content || null })
    }

    if (req.method === 'PUT') {
      if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.BUILDER_WRITE)) || !requireCsrf(req, res, principal)) return
      const { schema: inputSchema, revision } = req.body || {}
      const schema = migrateProjectSchema(inputSchema)
      if (schema?.project?.id !== projectId) return res.status(400).json({ error: 'Schema project id does not match projectId.' })
      const issues = validateProjectSchema(schema, { templateOnly: projectOutputTarget(project) === WINCC_OUTPUT_TARGET })
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

async function loadDraftWithDesignAssets(projectId) {
  const draft = await ProjectDraft.findById(projectId).select({ schema: 1, revision: 1 }).lean()
  if (!draft) return null
  const schema = migrateProjectSchema(draft.schema)
  const ids = referencedDesignAssetIds(schema)
  const assets = ids.length
    ? await ScadaAsset.find({ _id: { $in: ids }, projectId, kind: DESIGN_IMAGE_TYPE }).select({ metadata: 1, projectId: 1 }).lean()
    : []
  return { schema, revision: draft.revision, designAssets: publicDesignAssets(assets) }
}
