import { Project, ProjectMember } from './models.js'
import { isProjectUnlocked } from './project-pin.js'

export const PERMISSIONS = Object.freeze({
  WORKSPACE_MANAGE: 'workspace.manage',
  MEMBERS_MANAGE: 'members.manage',
  PROJECT_CREATE: 'project.create',
  PROJECT_MANAGE: 'project.manage',
  PROJECT_DELETE: 'project.delete',
  BUILDER_READ: 'builder.read',
  BUILDER_WRITE: 'builder.write',
  SOURCE_CONFIGURE: 'source.configure',
  CHART_STORAGE_MANAGE: 'chart-storage.manage',
  SECRET_ROTATE: 'secret.rotate',
  PROJECT_VALIDATE: 'project.validate',
  PROJECT_PUBLISH: 'project.publish',
  RUNTIME_VIEW: 'runtime.view',
  COMMAND_EXECUTE: 'command.execute',
  AUDIT_READ: 'audit.read',
})

const ROLE_CAPABILITIES = Object.freeze({
  OWNER: Object.values(PERMISSIONS),
  ADMIN: Object.values(PERMISSIONS),
  EDITOR: [PERMISSIONS.PROJECT_CREATE, PERMISSIONS.PROJECT_MANAGE, PERMISSIONS.BUILDER_READ, PERMISSIONS.BUILDER_WRITE, PERMISSIONS.SOURCE_CONFIGURE, PERMISSIONS.PROJECT_VALIDATE, PERMISSIONS.RUNTIME_VIEW],
  OPERATOR: [PERMISSIONS.RUNTIME_VIEW, PERMISSIONS.COMMAND_EXECUTE],
  VIEWER: [PERMISSIONS.RUNTIME_VIEW],
})

export function capabilitiesForRole(role) { return [...(ROLE_CAPABILITIES[role] || [])] }
export function roleCan(role, permission) { return Boolean(ROLE_CAPABILITIES[role]?.includes(permission)) }
export function roleMeetsRequirement(role, requiredRole = 'OPERATOR') {
  const accepted = {
    VIEWER: ['OWNER', 'ADMIN', 'EDITOR', 'OPERATOR', 'VIEWER'],
    EDITOR: ['OWNER', 'ADMIN', 'EDITOR'],
    OPERATOR: ['OWNER', 'ADMIN', 'OPERATOR'],
    ADMIN: ['OWNER', 'ADMIN'],
    OWNER: ['OWNER'],
  }
  return Boolean(accepted[requiredRole]?.includes(role))
}

export function requireWorkspacePermission(principal, res, permission) {
  if (principal && roleCan(principal.role, permission)) return true
  res.status(403).json({ error: 'Insufficient permission.', code: 'PERMISSION_DENIED', permission })
  return false
}

export async function requireProjectPermission(principal, res, projectOrId, permission, { bypassProjectLock = false } = {}) {
  const project = typeof projectOrId === 'string' ? await Project.findById(projectOrId) : projectOrId
  if (!project || project.workspaceId !== principal.workspaceId) {
    res.status(404).json({ error: 'Project not found.' })
    return null
  }
  let effectiveRole = principal.role
  if (!['OWNER', 'ADMIN', 'EDITOR'].includes(effectiveRole)) {
    const assignment = await ProjectMember.findOne({ projectId: project.id, userId: principal.id, status: 'active' }).lean()
    if (!assignment) {
      res.status(404).json({ error: 'Project not found.' })
      return null
    }
    effectiveRole = assignment.role
  }
  if (!roleCan(effectiveRole, permission)) {
    res.status(403).json({ error: 'Insufficient permission.', code: 'PERMISSION_DENIED', permission })
    return null
  }
  if (!bypassProjectLock && project.security?.pinEnabled && !(await isProjectUnlocked(principal, project))) {
    res.status(423).json({
      error: 'Project PIN is required.',
      code: 'PROJECT_LOCKED',
      projectId: String(project._id || project.id),
    })
    return null
  }
  return { project, effectiveRole, capabilities: capabilitiesForRole(effectiveRole) }
}

export async function accessibleProjectFilter(principal) {
  if (['OWNER', 'ADMIN', 'EDITOR'].includes(principal.role)) return { workspaceId: principal.workspaceId }
  const assignments = await ProjectMember.find({ userId: principal.id, status: 'active' }).select({ projectId: 1 }).lean()
  return { workspaceId: principal.workspaceId, _id: { $in: assignments.map(item => item.projectId) } }
}
