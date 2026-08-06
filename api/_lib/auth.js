import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { connectMongo } from './mongo.js'
import { AuthSession, RuntimeSession, RuntimeStreamSession, SimulationResponderLease, User, Workspace, WorkspaceMember } from './models.js'

const scrypt = promisify(scryptCallback)
const SESSION_COOKIE = 'scada_session'
const CSRF_COOKIE = 'scada_csrf'
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60
const DEFAULT_IDLE_TTL_SECONDS = 30 * 60
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000
const DEFAULT_WORKSPACE_ID = process.env.SCADA_WORKSPACE_ID || 'default'

function config() {
  const production = process.env.NODE_ENV === 'production'
  return {
    production,
    email: String(process.env.SCADA_ADMIN_EMAIL || 'admin@scada.local').trim().toLowerCase(),
    password: process.env.SCADA_ADMIN_PASSWORD || (production ? '' : 'admin'),
  }
}

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(String(password), salt, 64)
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`
}

export async function verifyPassword(password, encoded) {
  const [algorithm, salt, expectedHex] = String(encoded || '').split('$')
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false
  const actual = Buffer.from(await scrypt(String(password), salt, 64))
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function passwordChangeError({ currentPassword, newPassword, confirmPassword } = {}) {
  if (typeof currentPassword !== 'string' || !currentPassword) return 'Enter your current password.'
  if (currentPassword.length > 256) return 'Current password is too long.'
  if (typeof newPassword !== 'string' || newPassword.length < 10) return 'New password must contain at least 10 characters.'
  if (newPassword.length > 256) return 'New password must contain no more than 256 characters.'
  if (newPassword === currentPassword) return 'New password must be different from the current password.'
  if (typeof confirmPassword !== 'string' || confirmPassword !== newPassword) return 'New password confirmation does not match.'
  return null
}

export async function authenticateCredentials(email, password) {
  await connectMongo()
  const normalizedEmail = String(email || '').trim().toLowerCase()
  let user = await User.findOne({ email: normalizedEmail }).select('+passwordHash')
  const auth = config()
  const matchesBootstrap = Boolean(auth.password && normalizedEmail === auth.email && safeEqual(password, auth.password))
  let bootstrap = null
  if (!user && matchesBootstrap) {
    bootstrap = await bootstrapLocalOwner(auth)
    user = bootstrap.user
  }
  if (!user || user.status !== 'active' || !(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, configurationError: !auth.password }
  }
  let membership = bootstrap?.membership
    || await WorkspaceMember.findOne({ userId: user.id, status: 'active' }).lean()
  if (!membership && matchesBootstrap) {
    bootstrap = await bootstrapLocalOwner(auth)
    user = bootstrap.user
    membership = bootstrap.membership
  }
  if (!membership) return { ok: false, configurationError: false }
  return {
    ok: true,
    user: { id: user.id, email: user.email, displayName: user.displayName, authVersion: user.authVersion },
    membership,
  }
}

async function bootstrapLocalOwner(auth) {
  const passwordHash = await hashPassword(auth.password)
  const user = await User.findOneAndUpdate(
    { email: auth.email },
    { $setOnInsert: { _id: bootstrapOwnerId(auth.email), email: auth.email, displayName: 'Bootstrap Owner', passwordHash, status: 'active', authVersion: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).select('+passwordHash')
  const workspace = await findOrCreateBootstrapWorkspace(user.id)
  const membership = await WorkspaceMember.findOneAndUpdate(
    { workspaceId: workspace.id, userId: user.id },
    { $set: { role: 'OWNER', status: 'active' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
  return { user, membership: membership.toObject() }
}

export function bootstrapOwnerId(email) {
  return `owner-${digest(String(email || '').trim().toLowerCase()).slice(0, 24)}`
}

async function findOrCreateBootstrapWorkspace(ownerId) {
  const existing = await Workspace.findOne({
    $or: [{ _id: DEFAULT_WORKSPACE_ID }, { slug: 'default' }],
  })
  if (existing) return existing
  try {
    return await Workspace.create({
      _id: DEFAULT_WORKSPACE_ID,
      slug: 'default',
      name: 'Default Workspace',
      ownerId,
    })
  } catch (error) {
    if (error?.code !== 11000) throw error
    const raced = await Workspace.findOne({
      $or: [{ _id: DEFAULT_WORKSPACE_ID }, { slug: 'default' }],
    })
    if (!raced) throw error
    return raced
  }
}

export async function createSession(user, membership, req = {}) {
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(24).toString('base64url')
  const policy = sessionPolicy()
  const sessionId = digest(token)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + policy.absoluteTtlMs)
  await AuthSession.create({
    _id: sessionId,
    userId: user.id,
    workspaceId: membership.workspaceId,
    csrfHash: digest(csrfToken),
    authVersion: user.authVersion,
    expiresAt,
    lastSeenAt: now,
    userAgent: String(req.headers?.['user-agent'] || '').slice(0, 300),
  })
  await enforceAuthSessionCap(user.id, sessionId, policy.maxSessions)
  return { cookies: sessionCookies(token, csrfToken, policy), expiresAt }
}

export async function getPrincipal(req) {
  const token = parseCookies(req.headers?.cookie || '')[SESSION_COOKIE]
  if (!token) return null
  await connectMongo()
  const now = new Date()
  const session = await AuthSession.findOne({ _id: digest(token), revokedAt: null, expiresAt: { $gt: now } }).lean()
  if (!session) return null
  if (!isAuthSessionRecordActive(session, now)) {
    await revokeSessionHierarchy([session._id], now)
    return null
  }
  const [user, membership] = await Promise.all([
    User.findOne({ _id: session.userId, status: 'active' }).lean(),
    WorkspaceMember.findOne({ workspaceId: session.workspaceId, userId: session.userId, status: 'active' }).lean(),
  ])
  if (!user || !membership || user.authVersion !== session.authVersion) {
    await revokeSessionHierarchy([session._id], now)
    return null
  }
  if (now.getTime() - new Date(session.lastSeenAt || session.createdAt).getTime() >= LAST_SEEN_WRITE_INTERVAL_MS) {
    AuthSession.updateOne({ _id: session._id, revokedAt: null }, { $set: { lastSeenAt: now } }).catch(() => {})
  }
  return {
    id: user._id,
    email: user.email,
    displayName: user.displayName,
    workspaceId: membership.workspaceId,
    role: membership.role,
    sessionId: session._id,
    sessionExpiresAt: session.expiresAt,
    csrfHash: session.csrfHash,
    capabilities: [],
  }
}

export async function requirePrincipal(req, res) {
  const principal = await getPrincipal(req)
  if (!principal) {
    res.status(401).json({ error: 'Authentication required.' })
    return null
  }
  return principal
}

export function requireCsrf(req, res, principal) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true
  const cookies = parseCookies(req.headers?.cookie || '')
  const token = String(req.headers?.['x-csrf-token'] || '')
  if (!requireAllowedOrigin(req, res)) return false
  if (!token || !cookies[CSRF_COOKIE] || !safeEqual(token, cookies[CSRF_COOKIE]) || !safeEqual(digest(token), principal.csrfHash)) {
    res.status(403).json({ error: 'CSRF validation failed.', code: 'CSRF_REJECTED' })
    return false
  }
  return true
}

export function requireAllowedOrigin(req, res) {
  const origin = String(req.headers?.origin || '')
  if ((origin && allowedOrigins().includes(origin)) || (!origin && process.env.NODE_ENV !== 'production')) return true
  res.status(403).json({ error: 'Request origin is not allowed.', code: 'ORIGIN_REJECTED' })
  return false
}

export async function revokeSession(req) {
  const token = parseCookies(req.headers?.cookie || '')[SESSION_COOKIE]
  if (token) await revokeSessionHierarchy([digest(token)])
}

export async function revokeUserSessions(userId) {
  await connectMongo()
  const sessions = await AuthSession.find({ userId, revokedAt: null }).select({ _id: 1 }).lean()
  await revokeSessionHierarchy(sessions.map(session => session._id))
}

export async function rotateUserSessionsAfterPasswordChange(userId, currentSessionId, authVersion) {
  await connectMongo()
  const current = await AuthSession.updateOne(
    { _id: currentSessionId, userId, revokedAt: null },
    { $set: { authVersion } }
  )
  if (current.matchedCount !== 1) throw new Error('The current session is no longer active.')
  const otherSessions = await AuthSession.find({ userId, revokedAt: null, _id: { $ne: currentSessionId } }).select({ _id: 1 }).lean()
  await revokeSessionHierarchy(otherSessions.map(session => session._id))
}

export async function revokeSessionHierarchy(sessionIds, revokedAt = new Date()) {
  const ids = [...new Set((sessionIds || []).map(String).filter(Boolean))]
  if (!ids.length) return
  await connectMongo()
  const runtimes = await RuntimeSession.find({ authSessionId: { $in: ids }, revokedAt: null }).select({ _id: 1 }).lean()
  const runtimeIds = runtimes.map(runtime => runtime._id)
  await Promise.all([
    AuthSession.updateMany({ _id: { $in: ids }, revokedAt: null }, { $set: { revokedAt } }),
    RuntimeSession.updateMany({ authSessionId: { $in: ids }, revokedAt: null }, { $set: { revokedAt } }),
    runtimeIds.length
      ? RuntimeStreamSession.updateMany({ runtimeSessionId: { $in: runtimeIds }, revokedAt: null }, { $set: { revokedAt } })
      : Promise.resolve(),
    runtimeIds.length
      ? SimulationResponderLease.deleteMany({ runtimeSessionId: { $in: runtimeIds } })
      : Promise.resolve(),
  ])
}

export function clearSessionCookies() {
  const secure = config().production ? '; Secure' : ''
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${secure}`,
  ]
}

function sessionCookies(token, csrfToken, policy = sessionPolicy()) {
  const secure = config().production ? '; Secure' : ''
  const maxAge = Math.floor(policy.absoluteTtlMs / 1000)
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure}`,
  ]
}

export function parseCookies(header = '') {
  return header.split(';').reduce((result, entry) => {
    const index = entry.indexOf('=')
    if (index > 0) {
      const name = entry.slice(0, index).trim()
      try { result[name] = decodeURIComponent(entry.slice(index + 1).trim()) } catch { /* Ignore malformed cookies. */ }
    }
    return result
  }, {})
}

export function sessionPolicy() {
  const absoluteSeconds = boundedInteger(process.env.SCADA_SESSION_TTL_SECONDS, 5 * 60, 7 * 24 * 60 * 60, DEFAULT_SESSION_TTL_SECONDS)
  const idleSeconds = boundedInteger(process.env.SCADA_SESSION_IDLE_SECONDS, 5 * 60, absoluteSeconds, Math.min(DEFAULT_IDLE_TTL_SECONDS, absoluteSeconds))
  return {
    absoluteTtlMs: absoluteSeconds * 1000,
    idleTtlMs: idleSeconds * 1000,
    maxSessions: boundedInteger(process.env.SCADA_MAX_AUTH_SESSIONS, 1, 50, 10),
  }
}

export function isAuthSessionRecordActive(session, now = new Date()) {
  if (!session || session.revokedAt) return false
  const nowMs = new Date(now).getTime()
  const expiresAt = new Date(session.expiresAt).getTime()
  const lastSeenAt = new Date(session.lastSeenAt || session.createdAt || 0).getTime()
  return Number.isFinite(nowMs) && Number.isFinite(expiresAt) && Number.isFinite(lastSeenAt)
    && expiresAt > nowMs
    && lastSeenAt + sessionPolicy().idleTtlMs > nowMs
}

async function enforceAuthSessionCap(userId, currentSessionId, maximum) {
  const sessions = await AuthSession.find({ userId, revokedAt: null, _id: { $ne: currentSessionId } }).sort({ createdAt: -1 }).select({ _id: 1 }).lean()
  const excess = sessions.slice(Math.max(0, maximum - 1)).map(session => session._id)
  if (excess.length) await revokeSessionHierarchy(excess)
}

function digest(value) { return createHash('sha256').update(String(value)).digest('hex') }
function safeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}
export function allowedOrigins() {
  const configured = String(process.env.APP_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean)
  const local = process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173']
  return [...new Set([...configured, ...local])]
}
function boundedInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback
}
