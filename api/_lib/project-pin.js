import { createHash } from 'node:crypto'
import { hashPassword, verifyPassword } from './auth.js'
import { ProjectUnlockSession } from './models.js'

const DEFAULT_UNLOCK_SECONDS = 8 * 60 * 60

export function projectPinError(pin, confirmation = pin) {
  const value = String(pin || '')
  if (!/^\d{6}$/.test(value)) return 'Project PIN must contain exactly 6 digits.'
  if (value !== String(confirmation || '')) return 'Project PIN confirmation does not match.'
  if (/^(\d)\1{5}$/.test(value)) return 'Project PIN cannot repeat the same digit.'
  if ('0123456789'.includes(value) || '9876543210'.includes(value)) return 'Project PIN cannot use a simple sequence.'
  if (value.slice(0, 3) === value.slice(3)) return 'Project PIN cannot repeat the same three digits.'
  return null
}

export function hashProjectPin(pin) {
  return hashPassword(String(pin || ''))
}

export function verifyProjectPin(pin, encoded) {
  return verifyPassword(String(pin || ''), encoded)
}

export function projectUnlockPolicy(environment = process.env) {
  const value = Number(environment.SCADA_PROJECT_UNLOCK_SECONDS)
  const seconds = Number.isFinite(value)
    ? Math.min(12 * 60 * 60, Math.max(5 * 60, Math.round(value)))
    : DEFAULT_UNLOCK_SECONDS
  return { ttlMs: seconds * 1000 }
}

export async function grantProjectUnlock(principal, project, now = new Date()) {
  const projectId = String(project?._id || project?.id || '')
  const sessionExpiry = new Date(principal?.sessionExpiresAt || 0).getTime()
  const policyExpiry = now.getTime() + projectUnlockPolicy().ttlMs
  const expiresAt = new Date(Number.isFinite(sessionExpiry) && sessionExpiry > now.getTime() ? Math.min(sessionExpiry, policyExpiry) : policyExpiry)
  const record = await ProjectUnlockSession.findOneAndUpdate(
    { _id: projectUnlockId(principal.sessionId, projectId) },
    {
      $set: {
        authSessionId: principal.sessionId,
        userId: principal.id,
        projectId,
        pinVersion: Number(project?.security?.pinVersion || 0),
        expiresAt,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean()
  return record
}

export async function revokeProjectUnlock(principal, projectId) {
  return ProjectUnlockSession.deleteOne({ _id: projectUnlockId(principal.sessionId, projectId) })
}

export async function revokeProjectUnlocks(projectId) {
  return ProjectUnlockSession.deleteMany({ projectId: String(projectId || '') })
}

export async function isProjectUnlocked(principal, project, now = new Date()) {
  if (!project?.security?.pinEnabled) return true
  const projectId = String(project?._id || project?.id || '')
  const unlock = await ProjectUnlockSession.exists({
    _id: projectUnlockId(principal.sessionId, projectId),
    authSessionId: principal.sessionId,
    userId: principal.id,
    projectId,
    pinVersion: Number(project.security.pinVersion || 0),
    expiresAt: { $gt: now },
  })
  return Boolean(unlock)
}

export async function unlockedProjectIds(principal, projects, now = new Date()) {
  const locked = (projects || []).filter(project => project?.security?.pinEnabled)
  if (!locked.length) return new Set()
  const records = await ProjectUnlockSession.find({
    authSessionId: principal.sessionId,
    userId: principal.id,
    projectId: { $in: locked.map(project => String(project._id || project.id)) },
    expiresAt: { $gt: now },
  }).select({ projectId: 1, pinVersion: 1 }).lean()
  const versions = new Map(locked.map(project => [String(project._id || project.id), Number(project.security?.pinVersion || 0)]))
  return new Set(records.filter(record => versions.get(record.projectId) === Number(record.pinVersion)).map(record => record.projectId))
}

export function projectSecuritySnapshot(project, unlocked = false) {
  const enabled = Boolean(project?.security?.pinEnabled)
  return {
    pinEnabled: enabled,
    unlocked: !enabled || Boolean(unlocked),
    pinConfiguredAt: project?.security?.pinConfiguredAt || null,
  }
}

export function projectUnlockId(authSessionId, projectId) {
  return createHash('sha256').update(`${String(authSessionId || '')}:${String(projectId || '')}`).digest('hex')
}
