import { randomUUID } from 'node:crypto'
import { connectMongo } from '../_lib/mongo.js'
import { AuditEvent, Project, ProjectMember, User, WorkspaceMember } from '../_lib/models.js'
import { hashPassword, requireCsrf, requirePrincipal, revokeUserSessions } from '../_lib/auth.js'
import { PERMISSIONS, requireWorkspacePermission } from '../_lib/authorization.js'
import { requestId } from '../_lib/security.js'

const ASSIGNABLE_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'OPERATOR', 'VIEWER']

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (!requireWorkspacePermission(principal, res, PERMISSIONS.MEMBERS_MANAGE)) return
  await connectMongo()

  if (req.method === 'GET') {
    const memberships = await WorkspaceMember.find({ workspaceId: principal.workspaceId }).sort({ createdAt: 1 }).lean()
    const users = await User.find({ _id: { $in: memberships.map(item => item.userId) } }).lean()
    const byId = new Map(users.map(user => [user._id, user]))
    return res.status(200).json({ members: memberships.map(member => ({ id: member.userId, email: byId.get(member.userId)?.email, displayName: byId.get(member.userId)?.displayName || '', role: member.role, status: member.status, createdAt: member.createdAt })) })
  }

  if (!['POST', 'PATCH'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, PATCH')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  if (!requireCsrf(req, res, principal)) return
  const correlationId = requestId(req)

  if (req.method === 'POST') {
    const { email, displayName = '', password, role = 'VIEWER', projectIds = [] } = req.body || {}
    const normalizedEmail = String(email || '').trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) return res.status(400).json({ error: 'A valid email is required.' })
    if (String(password || '').length < 10) return res.status(400).json({ error: 'Password must contain at least 10 characters.' })
    if (!ASSIGNABLE_ROLES.includes(role) || (role === 'OWNER' && principal.role !== 'OWNER')) return res.status(403).json({ error: 'The requested role cannot be assigned.' })
    try {
      const user = await User.create({ _id: randomUUID(), email: normalizedEmail, displayName: String(displayName).trim().slice(0, 100), passwordHash: await hashPassword(password) })
      await WorkspaceMember.create({ workspaceId: principal.workspaceId, userId: user.id, role })
      await assignProjects(principal.workspaceId, user.id, role, projectIds)
      await AuditEvent.create({ workspaceId: principal.workspaceId, actorId: principal.id, action: 'member.created', targetType: 'user', targetId: user.id, correlationId, metadata: { email: normalizedEmail, role, projectCount: projectIds.length } })
      return res.status(201).json({ member: { id: user.id, email: user.email, displayName: user.displayName, role, status: 'active' } })
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ error: 'A user with this email already exists.' })
      throw error
    }
  }

  const { userId, role, status = 'active', projectIds = [] } = req.body || {}
  if (!userId || !ASSIGNABLE_ROLES.includes(role) || !['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'userId, role, and status are required.' })
  if ((role === 'OWNER' || userId === principal.id) && principal.role !== 'OWNER') return res.status(403).json({ error: 'Only the owner can perform this role change.' })
  if (userId === principal.id && (role !== 'OWNER' || status !== 'active')) return res.status(409).json({ error: 'The active owner cannot demote or disable their own account.' })
  const membership = await WorkspaceMember.findOneAndUpdate({ workspaceId: principal.workspaceId, userId }, { $set: { role, status } }, { new: true })
  if (!membership) return res.status(404).json({ error: 'Workspace member not found.' })
  await User.updateOne({ _id: userId }, { $inc: { authVersion: 1 } })
  await revokeUserSessions(userId)
  const workspaceProjects = await Project.find({ workspaceId: principal.workspaceId }).select({ _id: 1 }).lean()
  await ProjectMember.deleteMany({ userId, projectId: { $in: workspaceProjects.map(project => project._id) } })
  await assignProjects(principal.workspaceId, userId, role, projectIds)
  await AuditEvent.create({ workspaceId: principal.workspaceId, actorId: principal.id, action: 'member.role.changed', targetType: 'user', targetId: userId, correlationId, metadata: { role, status, projectCount: projectIds.length } })
  return res.status(200).json({ ok: true, member: { id: userId, role, status } })
}

async function assignProjects(workspaceId, userId, role, projectIds) {
  if (!['OPERATOR', 'VIEWER'].includes(role) || !Array.isArray(projectIds) || projectIds.length === 0) return
  const projects = await Project.find({ _id: { $in: projectIds.slice(0, 100) }, workspaceId }).select({ _id: 1 }).lean()
  if (projects.length) await ProjectMember.insertMany(projects.map(project => ({ projectId: project._id, userId, role })), { ordered: false })
}
