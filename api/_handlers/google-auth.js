import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { connectMongo, runMongoTransaction } from '../_lib/mongo.js'
import { AuditEvent, User, Workspace, WorkspaceMember } from '../_lib/models.js'
import { createSession, hashPassword, parseCookies, preferredWorkspaceMembership } from '../_lib/auth.js'
import { enforceRateLimit, isDatabaseUnavailableError, requestId } from '../_lib/security.js'

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_TOKEN_INFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo'
const GOOGLE_CALLBACK_PATH = '/api/auth/callback/google'
const OAUTH_COOKIE = 'scada_google_oauth'
const OAUTH_TTL_SECONDS = 10 * 60
const FETCH_TIMEOUT_MS = 10_000

export async function startGoogleAuth(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res)
  const next = normalizeOAuthNext(queryValue(req.query?.next))
  const configuration = googleOAuthConfiguration()
  if (!configuration.ok) return redirectWithError(res, next, 'google_not_configured')

  const transaction = createGoogleOAuthTransaction(configuration, next)
  res.setHeader('Set-Cookie', transaction.cookie)
  return redirect(res, transaction.authorizationUrl)
}

export async function callbackGoogleAuth(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res)
  const correlationId = requestId(req)
  const configuration = googleOAuthConfiguration()
  if (!configuration.ok) return redirectWithError(res, '/', 'google_not_configured')

  const transaction = readGoogleOAuthTransaction(parseCookies(req.headers?.cookie || '')[OAUTH_COOKIE], configuration)
  const next = normalizeOAuthNext(transaction?.next)
  const clearedCookie = googleOAuthCookie('', configuration, 0)
  res.setHeader('Set-Cookie', clearedCookie)

  const returnedState = queryValue(req.query?.state)
  if (!transaction || !returnedState || !safeEqual(returnedState, transaction.state)) {
    return redirectWithError(res, next, 'google_state_invalid')
  }
  if (queryValue(req.query?.error)) return redirectWithError(res, next, 'google_cancelled')

  const code = queryValue(req.query?.code)
  if (!code || code.length > 4096) return redirectWithError(res, next, 'google_response_invalid')

  try {
    if (!(await enforceRateLimit(req, res, 'google-callback-ip', { limit: 20, windowMs: 10 * 60_000 }))) return
    const identity = await exchangeGoogleAuthorizationCode(code, transaction, configuration)
    const { user, membership } = await findOrCreateGooglePrincipal(identity)
    const session = await createSession(user, membership, req)
    res.setHeader('Set-Cookie', [clearedCookie, ...session.cookies])
    await AuditEvent.create({
      workspaceId: membership.workspaceId,
      actorId: user.id,
      action: 'auth.google.succeeded',
      targetType: 'session',
      correlationId,
      metadata: { provider: 'google' },
    }).catch(() => {})
    return redirect(res, next)
  } catch (error) {
    const code = isDatabaseUnavailableError(error)
      ? 'database_unavailable'
      : error instanceof GoogleAuthError
        ? error.code
        : 'google_login_failed'
    await AuditEvent.create({
      actorId: 'anonymous',
      action: 'auth.google.failed',
      targetType: 'session',
      correlationId,
      metadata: { code },
    }).catch(() => {})
    return redirectWithError(res, next, code)
  }
}

export function googleOAuthConfiguration(env = process.env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim()
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim()
  const redirectUri = String(env.GOOGLE_REDIRECT_URI || '').trim()
  if (!clientId || !clientSecret || !redirectUri || clientId.length > 500 || clientSecret.length > 500 || redirectUri.length > 1000) {
    return { ok: false, code: 'GOOGLE_OAUTH_NOT_CONFIGURED' }
  }
  try {
    const url = new URL(redirectUri)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const secure = url.protocol === 'https:'
    const allowedProtocol = secure || (env.NODE_ENV !== 'production' && local && url.protocol === 'http:')
    if (!allowedProtocol || url.username || url.password || url.search || url.hash || url.pathname !== GOOGLE_CALLBACK_PATH) {
      return { ok: false, code: 'GOOGLE_REDIRECT_URI_INVALID' }
    }
    return { ok: true, clientId, clientSecret, redirectUri: url.href, secure }
  } catch {
    return { ok: false, code: 'GOOGLE_REDIRECT_URI_INVALID' }
  }
}

export function normalizeOAuthNext(value) {
  const candidate = String(value || '/').trim()
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\') || candidate.length > 500 || /[\u0000-\u001f\u007f]/.test(candidate)) return '/'
  try {
    const base = new URL('https://scamatic.invalid')
    const resolved = new URL(candidate, base)
    if (resolved.origin !== base.origin) return '/'
    return `${resolved.pathname}${resolved.search}`
  } catch {
    return '/'
  }
}

export function createGoogleOAuthTransaction(configuration, next = '/', now = Date.now()) {
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const payload = {
    version: 1,
    state,
    nonce,
    verifier,
    next: normalizeOAuthNext(next),
    expiresAt: now + OAUTH_TTL_SECONDS * 1000,
  }
  const encoded = encodeSignedPayload(payload, configuration.clientSecret)
  const authorizationUrl = new URL(GOOGLE_AUTH_ENDPOINT)
  authorizationUrl.search = new URLSearchParams({
    client_id: configuration.clientId,
    redirect_uri: configuration.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()
  return {
    ...payload,
    authorizationUrl: authorizationUrl.href,
    cookie: googleOAuthCookie(encoded, configuration, OAUTH_TTL_SECONDS),
  }
}

export function readGoogleOAuthTransaction(value, configuration, now = Date.now()) {
  const payload = decodeSignedPayload(value, configuration?.clientSecret)
  if (!payload || payload.version !== 1 || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= now) return null
  if (!isOAuthToken(payload.state) || !isOAuthToken(payload.nonce) || !isOAuthToken(payload.verifier)) return null
  return { ...payload, next: normalizeOAuthNext(payload.next) }
}

async function exchangeGoogleAuthorizationCode(code, transaction, configuration) {
  const tokenResponse = await fetchJson(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      code,
      code_verifier: transaction.verifier,
      grant_type: 'authorization_code',
      redirect_uri: configuration.redirectUri,
    }),
  }, 'google_exchange_failed')
  const idToken = String(tokenResponse.id_token || '')
  if (!idToken || idToken.length > 10_000) throw new GoogleAuthError('google_exchange_failed')

  const tokenInfoUrl = new URL(GOOGLE_TOKEN_INFO_ENDPOINT)
  tokenInfoUrl.searchParams.set('id_token', idToken)
  const tokenInfo = await fetchJson(tokenInfoUrl, {}, 'google_identity_invalid')
  const tokenClaims = decodeJwtPayload(idToken)
  const issuer = String(tokenInfo.iss || '')
  const audience = String(tokenInfo.aud || '')
  const nonce = String(tokenInfo.nonce || tokenClaims?.nonce || '')
  const expiresAt = Number(tokenInfo.exp)
  const email = String(tokenInfo.email || '').trim().toLowerCase()
  const verified = tokenInfo.email_verified === true || tokenInfo.email_verified === 'true'
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(issuer)
    || audience !== configuration.clientId
    || !safeEqual(nonce, transaction.nonce)
    || !Number.isFinite(expiresAt)
    || expiresAt * 1000 <= Date.now()
    || !verified
    || !/^\S+@\S+\.\S+$/.test(email)
    || email.length > 120
    || !String(tokenInfo.sub || '')) {
    throw new GoogleAuthError('google_identity_invalid')
  }
  return {
    email,
    displayName: cleanDisplayName(tokenInfo.name || tokenClaims?.name),
  }
}

async function findOrCreateGooglePrincipal(identity) {
  await connectMongo()
  let user = await User.findOne({ email: identity.email }).lean()
  if (user) {
    if (user.status !== 'active') throw new GoogleAuthError('account_disabled')
    const membership = await preferredWorkspaceMembership(user._id, user.preferredWorkspaceId)
    if (!membership) throw new GoogleAuthError('account_access_disabled')
    await User.updateOne(
      { _id: user._id },
      {
        $addToSet: { authProviders: 'google' },
        ...(!user.displayName && identity.displayName ? { $set: { displayName: identity.displayName } } : {}),
      }
    )
    if (!user.displayName && identity.displayName) user = { ...user, displayName: identity.displayName }
    return { user: publicSessionUser(user), membership }
  }

  const userId = randomUUID()
  const workspaceId = randomUUID()
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'))
  try {
    await runMongoTransaction(async session => {
      const options = session ? { session } : undefined
      await User.create([{
        _id: userId,
        email: identity.email,
        displayName: identity.displayName,
        passwordHash,
        authProviders: ['google'],
      }], options)
      await Workspace.create([{
        _id: workspaceId,
        slug: `personal-${userId.slice(0, 12)}`,
        name: identity.displayName ? `${identity.displayName}'s Workspace` : 'My SCADA Workspace',
        ownerId: userId,
      }], options)
      await WorkspaceMember.create([{ workspaceId, userId, role: 'OWNER', status: 'active' }], options)
    })
  } catch (error) {
    if (error?.code !== 11000) throw error
    user = await User.findOne({ email: identity.email }).lean()
    if (!user || user.status !== 'active') throw new GoogleAuthError('account_disabled')
    const membership = await preferredWorkspaceMembership(user._id, user.preferredWorkspaceId)
    if (!membership) throw new GoogleAuthError('account_access_disabled')
    return { user: publicSessionUser(user), membership }
  }
  return {
    user: { id: userId, email: identity.email, displayName: identity.displayName, authVersion: 1 },
    membership: { workspaceId, userId, role: 'OWNER', status: 'active' },
  }
}

async function fetchJson(url, options, errorCode) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new GoogleAuthError(errorCode)
    return data
  } catch (error) {
    if (error instanceof GoogleAuthError) throw error
    throw new GoogleAuthError(errorCode)
  } finally {
    clearTimeout(timer)
  }
}

function googleOAuthCookie(value, configuration, maxAge) {
  return `${OAUTH_COOKIE}=${encodeURIComponent(value)}; Path=${GOOGLE_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${configuration.secure ? '; Secure' : ''}`
}

function encodeSignedPayload(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function decodeSignedPayload(value, secret) {
  if (!value || !secret) return null
  const [encoded, signature, extra] = String(value).split('.')
  if (!encoded || !signature || extra) return null
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url')
  if (!safeEqual(signature, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null
  } catch {
    return null
  }
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.')
    if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function authErrorLocation(next, code) {
  const url = new URL(normalizeOAuthNext(next), 'https://scamatic.invalid')
  url.searchParams.set('auth_error', String(code || 'google_login_failed').slice(0, 80))
  return `${url.pathname}${url.search}`
}

function redirectWithError(res, next, code) { return redirect(res, authErrorLocation(next, code)) }
function redirect(res, location) {
  res.statusCode = 302
  res.setHeader('Location', location)
  return res.end()
}
function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET')
  return res.status(405).json({ error: 'Method not allowed.' })
}
function queryValue(value) { return String(Array.isArray(value) ? value[0] : value || '').slice(0, 4096) }
function isOAuthToken(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value) }
function safeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}
function cleanDisplayName(value) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) }
function publicSessionUser(user) {
  return { id: String(user._id || user.id), email: user.email, displayName: user.displayName || '', authVersion: Number(user.authVersion) || 1 }
}

class GoogleAuthError extends Error {
  constructor(code) { super(code); this.name = 'GoogleAuthError'; this.code = code }
}
