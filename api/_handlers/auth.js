import { randomUUID } from 'node:crypto'
import { AuditEvent, User } from '../_lib/models.js'
import { authenticateCredentials, clearSessionCookies, createSession, getPrincipal, hashPassword, passwordChangeError, requireAllowedOrigin, requireCsrf, revokeSession, rotateUserSessionsAfterPasswordChange, verifyPassword } from '../_lib/auth.js'
import { capabilitiesForRole } from '../_lib/authorization.js'
import { enforceRateLimit, isDatabaseUnavailableError, publicError } from '../_lib/security.js'

export default async function handler(req, res) {
  const correlationId = requestId(req)
  try {
    return await handleRequest(req, res, correlationId)
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return publicError(res, 503, 'Database is temporarily unavailable. Verify MongoDB connectivity and try again.', 'DATABASE_UNAVAILABLE', correlationId)
    }
    throw error
  }
}

async function handleRequest(req, res, correlationId) {
  if (req.method === 'GET') {
    const principal = await getPrincipal(req)
    if (!principal) return res.status(401).json({ error: 'Authentication required.' })
    return res.status(200).json({ user: publicPrincipal(principal) })
  }

  if (req.method === 'POST') {
    if (!requireAllowedOrigin(req, res)) return
    const { email = '', password = '' } = req.body || {}
    const normalizedEmail = String(email).trim().toLowerCase().slice(0, 120)
    if (!(await enforceRateLimit(req, res, 'login-ip', { limit: 12, windowMs: 60_000 }))) return
    if (!(await enforceRateLimit(req, res, 'login-account', { limit: 20, windowMs: 10 * 60_000, identity: normalizedEmail, includeSource: false }))) return
    const result = await authenticateCredentials(email, password)
    if (!result.ok) {
      await AuditEvent.create({ actorId: 'anonymous', action: 'auth.login.failed', targetType: 'session', correlationId, metadata: { email: normalizedEmail } }).catch(() => {})
      if (result.configurationError) return res.status(503).json({ error: 'Authentication is not configured.' })
      return res.status(401).json({ error: 'Invalid email or password.' })
    }
    const session = await createSession(result.user, result.membership, req)
    res.setHeader('Set-Cookie', session.cookies)
    await AuditEvent.create({ workspaceId: result.membership.workspaceId, actorId: result.user.id, action: 'auth.login.succeeded', targetType: 'session', correlationId })
    return res.status(200).json({ ok: true, user: publicPrincipal({ ...result.user, role: result.membership.role, workspaceId: result.membership.workspaceId }) })
  }

  if (req.method === 'DELETE') {
    const principal = await getPrincipal(req)
    if (principal && !requireCsrf(req, res, principal)) return
    await revokeSession(req)
    res.setHeader('Set-Cookie', clearSessionCookies())
    if (principal) await AuditEvent.create({ workspaceId: principal.workspaceId, actorId: principal.id, action: 'auth.logout', targetType: 'session', targetId: principal.sessionId, correlationId })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'PATCH') {
    const principal = await getPrincipal(req)
    if (!principal) return res.status(401).json({ error: 'Authentication required.' })
    if (!requireCsrf(req, res, principal)) return
    if (!(await enforceRateLimit(req, res, 'password-change', { limit: 5, windowMs: 15 * 60_000, identity: principal.id, includeSource: false }))) return

    const input = req.body || {}
    const validationError = passwordChangeError(input)
    if (validationError) return res.status(400).json({ error: validationError })

    const user = await User.findOne({ _id: principal.id, status: 'active' }).select('+passwordHash')
    if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
      await AuditEvent.create({ workspaceId: principal.workspaceId, actorId: principal.id, action: 'auth.password.change.failed', targetType: 'user', targetId: principal.id, correlationId }).catch(() => {})
      return res.status(401).json({ error: 'Current password is incorrect.' })
    }

    const passwordHash = await hashPassword(input.newPassword)
    const updatedUser = await User.findOneAndUpdate(
      { _id: principal.id, status: 'active', authVersion: user.authVersion },
      { $set: { passwordHash }, $inc: { authVersion: 1 } },
      { new: true }
    ).lean()
    if (!updatedUser) return res.status(409).json({ error: 'Account changed while updating the password. Please try again.' })

    await rotateUserSessionsAfterPasswordChange(principal.id, principal.sessionId, updatedUser.authVersion)
    await AuditEvent.create({ workspaceId: principal.workspaceId, actorId: principal.id, action: 'auth.password.changed', targetType: 'user', targetId: principal.id, correlationId })
    return res.status(200).json({ ok: true, otherSessionsRevoked: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: `Method ${req.method} not allowed` })
}

function publicPrincipal(principal) {
  return { id: principal.id, email: principal.email, displayName: principal.displayName || '', workspaceId: principal.workspaceId, role: principal.role, capabilities: capabilitiesForRole(principal.role) }
}
function requestId(req) { return String(req.headers?.['x-request-id'] || randomUUID()).slice(0, 100) }
