import { randomUUID } from 'node:crypto'
import { connectMongo, runMongoTransaction } from '../_lib/mongo.js'
import { AuditEvent, User, Workspace, WorkspaceMember } from '../_lib/models.js'
import { createSession, hashPassword, requireAllowedOrigin, signupValidationError } from '../_lib/auth.js'
import { capabilitiesForRole } from '../_lib/authorization.js'
import { enforceRateLimit, isDatabaseUnavailableError, publicError, requestId } from '../_lib/security.js'

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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  if (!requireAllowedOrigin(req, res)) return

  const input = req.body || {}
  const normalizedEmail = String(input.email || '').trim().toLowerCase()
  const displayName = String(input.displayName || '').trim().slice(0, 100)
  const validationError = signupValidationError(input)
  if (validationError) return res.status(400).json({ error: validationError, code: 'SIGNUP_INVALID' })
  if (!(await enforceRateLimit(req, res, 'signup-ip', { limit: 5, windowMs: 15 * 60_000 }))) return
  if (!(await enforceRateLimit(req, res, 'signup-account', { limit: 3, windowMs: 60 * 60_000, identity: normalizedEmail, includeSource: false }))) return

  await connectMongo()
  const passwordHash = await hashPassword(input.password)
  const userId = randomUUID()
  const workspaceId = randomUUID()
  const workspaceName = displayName ? `${displayName}'s Workspace` : 'My SCADA Workspace'

  try {
    await runMongoTransaction(async session => {
      const options = session ? { session } : undefined
      await User.create([{ _id: userId, email: normalizedEmail, displayName, passwordHash }], options)
      await Workspace.create([{
        _id: workspaceId,
        slug: `personal-${userId.slice(0, 12)}`,
        name: workspaceName,
        ownerId: userId,
      }], options)
      await WorkspaceMember.create([{ workspaceId, userId, role: 'OWNER', status: 'active' }], options)
    })
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'An account with this email already exists.', code: 'ACCOUNT_EXISTS' })
    throw error
  }

  const user = { id: userId, email: normalizedEmail, displayName, authVersion: 1 }
  const membership = { workspaceId, userId, role: 'OWNER', status: 'active' }
  const session = await createSession(user, membership, req)
  res.setHeader('Set-Cookie', session.cookies)
  await AuditEvent.create({
    workspaceId,
    actorId: userId,
    action: 'auth.signup.succeeded',
    targetType: 'user',
    targetId: userId,
    correlationId,
    metadata: { email: normalizedEmail },
  })
  return res.status(201).json({
    ok: true,
    user: {
      id: userId,
      email: normalizedEmail,
      displayName,
      workspaceId,
      role: 'OWNER',
      capabilities: capabilitiesForRole('OWNER'),
    },
  })
}
