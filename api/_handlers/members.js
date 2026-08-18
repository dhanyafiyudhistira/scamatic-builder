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
    const requestedEmail = String(req.query?.email || '').trim().toLowerCase()
    if (requestedEmail) {
      if (requestedEmail.length > 120 || !/^\S+@\S+\.\S+$/.test(requestedEmail)) return res.status(400).json({ error: 'A valid email is required.' })
      const user = await User.findOne({ email: requestedEmail }).lean()
      const membership = user
        ? await WorkspaceMember.findOne({ workspaceId: principal.workspaceId, userId: user._id }).lean()
        : null
      return res.status(200).json({ account: memberAccountAvailability(user, membership, requestedEmail) })
    }
    const memberships = await WorkspaceMember.find({ workspaceId: principal.workspaceId }).sort({ createdAt: 1 }).lean()
    const memberUserIds = memberships.map(item => item.userId)
    const [users, workspaceProjects] = await Promise.all([
      User.find({ _id: { $in: memberUserIds } }).lean(),
      Project.find({ workspaceId: principal.workspaceId }).select({ _id: 1 }).lean(),
    ])
    const workspaceProjectIds = workspaceProjects.map(project => project._id)
    const projectMemberships = memberUserIds.length && workspaceProjectIds.length
      ? await ProjectMember.find({ userId: { $in: memberUserIds }, projectId: { $in: workspaceProjectIds }, status: 'active' }).select({ userId: 1, projectId: 1 }).lean()
      : []
    return res.status(200).json({
      members: memberDirectoryEntries(memberships, users, projectMemberships),
    })
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
    const normalizedDisplayName = String(displayName || '').trim().slice(0, 100)
    const selectedProjectIds = Array.isArray(projectIds) ? projectIds : []
    if (normalizedEmail.length > 120 || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) return res.status(400).json({ error: 'A valid email is required.' })
    if (!ASSIGNABLE_ROLES.includes(role) || (role === 'OWNER' && principal.role !== 'OWNER')) return res.status(403).json({ error: 'The requested role cannot be assigned.' })

    let user = await User.findOne({ email: normalizedEmail }).lean()
    let existingAccount = Boolean(user)
    if (!user) {
      if (!normalizedDisplayName) return res.status(400).json({ error: 'Display name is required for a new account.' })
      if (String(password || '').length < 10) return res.status(400).json({ error: 'Password must contain at least 10 characters.' })
      if (String(password).length > 256) return res.status(400).json({ error: 'Password must contain no more than 256 characters.' })
      try {
        const createdUser = await User.create({ _id: randomUUID(), email: normalizedEmail, displayName: normalizedDisplayName, passwordHash: await hashPassword(password) })
        user = createdUser.toObject()
      } catch (error) {
        if (error.code !== 11000) throw error
        // Another request may have created the identity after the availability check.
        // Re-read it and continue through the existing-account path without changing credentials.
        user = await User.findOne({ email: normalizedEmail }).lean()
        existingAccount = true
        if (!user) throw error
      }
    }

    const availability = memberAccountAvailability(
      user,
      await WorkspaceMember.findOne({ workspaceId: principal.workspaceId, userId: user._id }).lean(),
      normalizedEmail
    )
    if (!availability.available) return res.status(409).json({ error: availability.message, code: availability.code, account: availability })

    try {
      await WorkspaceMember.create({ workspaceId: principal.workspaceId, userId: user._id, role })
      await assignProjects(principal.workspaceId, user._id, role, selectedProjectIds)
      await AuditEvent.create({ workspaceId: principal.workspaceId, actorId: principal.id, action: existingAccount ? 'member.linked' : 'member.created', targetType: 'user', targetId: user._id, correlationId, metadata: { email: normalizedEmail, role, projectCount: selectedProjectIds.length, existingAccount } })
      return res.status(201).json({
        member: { id: user._id, email: user.email, displayName: user.displayName, role, status: 'active' },
        existingAccount,
        message: existingAccount ? 'Existing account linked to this workspace.' : 'Account created and added to this workspace.',
      })
    } catch (error) {
      if (error.code === 11000) {
        const account = memberAccountAvailability(user, { status: 'active' }, normalizedEmail)
        return res.status(409).json({ error: account.message, code: account.code, account })
      }
      throw error
    }
  }

  const { userId, role, status = 'active', projectIds = [] } = req.body || {}
  const selectedProjectIds = Array.isArray(projectIds) ? projectIds : []
  if (!userId || !ASSIGNABLE_ROLES.includes(role) || !['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'userId, role, and status are required.' })
  const targetMembership = await WorkspaceMember.findOne({ workspaceId: principal.workspaceId, userId }).lean()
  if (!targetMembership) return res.status(404).json({ error: 'Workspace member not found.' })
  const policyError = memberMutationError({
    actorId: principal.id,
    actorRole: principal.role,
    targetUserId: userId,
    targetRole: targetMembership.role,
    nextRole: role,
    nextStatus: status,
  })
  if (policyError) return res.status(policyError.status).json({ error: policyError.message, code: policyError.code })
  const membershipFilter = {
    workspaceId: principal.workspaceId,
    userId,
    ...(principal.role === 'OWNER' ? {} : { role: { $ne: 'OWNER' } }),
  }
  const membership = await WorkspaceMember.findOneAndUpdate(membershipFilter, { $set: { role, status } }, { new: true })
  if (!membership) return res.status(409).json({ error: 'Member authority changed while updating access. Reload and try again.', code: 'MEMBER_AUTHORITY_CHANGED' })
  await User.updateOne({ _id: userId }, { $inc: { authVersion: 1 } })
  await revokeUserSessions(userId)
  const workspaceProjects = await Project.find({ workspaceId: principal.workspaceId }).select({ _id: 1 }).lean()
  await ProjectMember.deleteMany({ userId, projectId: { $in: workspaceProjects.map(project => project._id) } })
  await assignProjects(principal.workspaceId, userId, role, selectedProjectIds)
  await AuditEvent.create({ workspaceId: principal.workspaceId, actorId: principal.id, action: 'member.role.changed', targetType: 'user', targetId: userId, correlationId, metadata: { role, status, projectCount: selectedProjectIds.length } })
  return res.status(200).json({ ok: true, member: { id: userId, role, status, projectIds: selectedProjectIds } })
}

export function memberAccountAvailability(user, membership, email = '') {
  const normalizedEmail = String(user?.email || email || '').trim().toLowerCase()
  if (!user) return {
    state: 'new_account',
    code: 'NEW_ACCOUNT',
    email: normalizedEmail,
    displayName: '',
    exists: false,
    available: true,
    passwordRequired: true,
    message: 'No account found. A new account will be created.',
  }
  if (user.status !== 'active') return {
    state: 'account_disabled',
    code: 'ACCOUNT_DISABLED',
    email: normalizedEmail,
    displayName: user.displayName || '',
    exists: true,
    available: false,
    passwordRequired: false,
    message: 'This account is disabled and cannot be added to a workspace.',
  }
  if (membership?.status === 'active') return {
    state: 'already_member',
    code: 'ALREADY_WORKSPACE_MEMBER',
    email: normalizedEmail,
    displayName: user.displayName || '',
    exists: true,
    available: false,
    passwordRequired: false,
    message: 'This account is already a member of the workspace.',
  }
  if (membership) return {
    state: 'membership_disabled',
    code: 'WORKSPACE_MEMBERSHIP_DISABLED',
    email: normalizedEmail,
    displayName: user.displayName || '',
    exists: true,
    available: false,
    passwordRequired: false,
    message: 'This account has a disabled membership in the workspace. Reactivate that membership instead of adding it again.',
  }
  return {
    state: 'available',
    code: 'EXISTING_ACCOUNT_AVAILABLE',
    email: normalizedEmail,
    displayName: user.displayName || '',
    exists: true,
    available: true,
    passwordRequired: false,
    message: 'Existing active account found. Its current sign-in credentials will be preserved.',
  }
}

export function memberDirectoryEntries(memberships = [], users = [], projectMemberships = []) {
  const byId = new Map(users.map(user => [String(user._id), user]))
  const projectIdsByUser = new Map()
  for (const projectMembership of projectMemberships) {
    const key = String(projectMembership.userId)
    const assignedProjectIds = projectIdsByUser.get(key) || []
    assignedProjectIds.push(String(projectMembership.projectId))
    projectIdsByUser.set(key, assignedProjectIds)
  }
  return memberships.map(member => {
    const user = byId.get(String(member.userId))
    return {
      id: member.userId,
      email: user?.email,
      displayName: user?.displayName || '',
      role: member.role,
      status: member.status,
      projectIds: projectIdsByUser.get(String(member.userId)) || [],
      createdAt: member.createdAt,
    }
  })
}

export function memberMutationError({ actorId, actorRole, targetUserId, targetRole, nextRole, nextStatus } = {}) {
  const changesOwner = targetRole === 'OWNER' || nextRole === 'OWNER'
  const changesSelf = String(targetUserId || '') === String(actorId || '')
  if (actorRole !== 'OWNER' && (changesOwner || changesSelf)) {
    return { status: 403, code: 'OWNER_REQUIRED', message: 'Only the owner can perform this member change.' }
  }
  if (changesSelf && (nextRole !== 'OWNER' || nextStatus !== 'active')) {
    return { status: 409, code: 'ACTIVE_OWNER_REQUIRED', message: 'The active owner cannot demote or disable their own account.' }
  }
  return null
}

async function assignProjects(workspaceId, userId, role, projectIds) {
  if (!['OPERATOR', 'VIEWER'].includes(role) || !Array.isArray(projectIds) || projectIds.length === 0) return
  const projects = await Project.find({ _id: { $in: projectIds.slice(0, 100) }, workspaceId }).select({ _id: 1 }).lean()
  if (projects.length) await ProjectMember.insertMany(projects.map(project => ({ projectId: project._id, userId, role })), { ordered: false })
}
