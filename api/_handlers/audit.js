import { connectMongo } from '../_lib/mongo.js'
import { AuditEvent, Project } from '../_lib/models.js'
import { requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  const projectId = String(req.query?.projectId || '')
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' })
  await connectMongo()
  const project = await Project.findById(projectId)
  if (!project || !(await requireProjectPermission(principal, res, project, PERMISSIONS.AUDIT_READ))) return
  const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 30)))
  const filter = { workspaceId: principal.workspaceId, projectId }
  if (req.query?.action) filter.action = String(req.query.action).slice(0, 100)
  if (req.query?.before) filter.timestamp = { $lt: new Date(req.query.before) }
  const events = await AuditEvent.find(filter).sort({ timestamp: -1, _id: -1 }).limit(limit + 1).lean()
  const hasMore = events.length > limit
  const page = events.slice(0, limit)
  return res.status(200).json({ events: page.map(event => ({ id: event._id, actorId: event.actorId, action: event.action, targetType: event.targetType, targetId: event.targetId, correlationId: event.correlationId, metadata: event.metadata, timestamp: event.timestamp })), nextCursor: hasMore ? page.at(-1)?.timestamp : null })
}
