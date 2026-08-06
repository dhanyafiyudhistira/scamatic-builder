import { connectMongo } from '../_lib/mongo.js'
import { AuditEvent, Project, ScadaAsset } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { enforceRateLimit } from '../_lib/security.js'
import { prepareDesignAsset, publicDesignAssets } from '../_lib/design-assets.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  const projectId = String(req.query?.projectId || req.body?.projectId || '')
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' })

  if (req.method === 'GET') {
    try {
      const assetId = String(req.query?.assetId || '')
      if (!assetId) return res.status(400).json({ error: 'assetId is required.' })
      await connectMongo()
      const project = await Project.findById(projectId)
      if (!project) return res.status(404).json({ error: 'Project not found.' })
      if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.RUNTIME_VIEW))) return
      const asset = await ScadaAsset.findOne({ _id: assetId, projectId, kind: 'design-image' }).lean()
      if (!asset) return res.status(404).json({ error: 'Design element not found.' })
      const mimeType = asset.metadata?.mimeType
      const body = mimeType === 'image/svg+xml' ? asset.content : Buffer.from(asset.content, 'base64')
      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Disposition', `inline; filename="${String(asset.metadata?.fileName || 'element').replace(/["\\\r\n]/g, '_')}"`)
      res.setHeader('Cache-Control', 'private, max-age=300')
      return res.status(200).send(body)
    } catch {
      return res.status(500).json({ error: 'Unable to load design element.' })
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  if (!requireCsrf(req, res, principal)) return
  const { fileName, mimeType, content } = req.body || {}
  if (!(await enforceRateLimit(req, res, 'element-upload', { limit: 20, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return

  try {
    const prepared = prepareDesignAsset({ fileName, mimeType, content })
    await connectMongo()
    const project = await Project.findById(projectId)
    if (!project) return res.status(404).json({ error: 'Project not found.' })
    if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.BUILDER_WRITE))) return
    const asset = await ScadaAsset.create({ projectId, ...prepared, createdBy: principal.id })
    await AuditEvent.create({
      workspaceId: principal.workspaceId,
      projectId,
      actorId: principal.id,
      action: 'asset.element.upload',
      targetType: 'asset',
      targetId: asset.id,
      metadata: { fileName: prepared.metadata.fileName, mimeType: prepared.metadata.mimeType, checksum: prepared.checksum, byteLength: prepared.byteLength },
    })
    return res.status(201).json({ asset: publicDesignAssets([asset.toObject()])[asset.id] })
  } catch (error) {
    const clientError = /Image|SVG|File|base64|format|media type/i.test(error.message)
    return res.status(clientError ? 422 : 500).json({ error: clientError ? error.message : 'Unable to store design element.' })
  }
}
