import { randomUUID } from 'node:crypto'
import { AuditEvent, ConnectorEnvironment, ConnectorSecret } from './models.js'
import { connectorSecretId, decryptConnectorSecret, encryptConnectorSecret } from './connector-secrets.js'
import { assertSafeConnectorTarget } from './connector-target.js'

const SECRET_FIELDS = '+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion'
const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000
const REFRESH_LEASE_MS = 30_000
const REFRESH_WAIT_MS = 3_000

export function thingsBoardJwtExpiresAt(token) {
  try {
    const payload = String(token || '').split('.')[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    const milliseconds = Number(claims?.exp) * 1000
    return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds) : null
  } catch {
    return null
  }
}

export function thingsBoardAuthenticationMetadata(secret = {}, { now = new Date(), refreshed = false } = {}) {
  const accessTokenExpiresAt = thingsBoardJwtExpiresAt(secret.jwt)
  const refreshTokenExpiresAt = thingsBoardJwtExpiresAt(secret.refreshToken)
  const automatic = Boolean(secret.refreshToken)
  const accessExpiresSoon = accessTokenExpiresAt && accessTokenExpiresAt.getTime() <= now.getTime() + DEFAULT_REFRESH_WINDOW_MS
  const refreshExpired = refreshTokenExpiresAt && refreshTokenExpiresAt.getTime() <= now.getTime()
  return {
    mode: automatic ? 'refresh-token' : secret.jwt ? 'manual-jwt' : 'unconfigured',
    state: !secret.jwt
      ? 'unconfigured'
      : refreshExpired
        ? 'error'
        : automatic
          ? accessExpiresSoon ? 'expiring' : 'healthy'
          : 'manual',
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    ...(refreshed ? { lastRefreshedAt: now } : {}),
    message: !secret.jwt
      ? 'ThingsBoard authentication is not configured.'
      : refreshExpired
        ? 'ThingsBoard refresh token expired; reconnect the account.'
        : automatic
          ? accessExpiresSoon ? 'JWT refresh is due.' : 'JWT auto-refresh is active.'
          : 'Manual JWT rotation is active.',
  }
}

export function mergeThingsBoardSecret(currentSecret = {}, updates = {}) {
  if (updates.refreshToken != null && updates.jwt == null) {
    throw new TypeError('A refresh token must be rotated together with its access JWT.')
  }
  const nextSecret = {
    ...(currentSecret.jwt ? { jwt: currentSecret.jwt } : {}),
    ...(currentSecret.refreshToken ? { refreshToken: currentSecret.refreshToken } : {}),
    ...(currentSecret.deviceToken ? { deviceToken: currentSecret.deviceToken } : {}),
  }
  if (updates.jwt != null) {
    nextSecret.jwt = updates.jwt
    // A refresh token belongs to the access-token pair that issued it. Rotating
    // only the JWT intentionally returns the connector to safe manual mode.
    if (updates.refreshToken == null) delete nextSecret.refreshToken
  }
  if (updates.refreshToken != null) nextSecret.refreshToken = updates.refreshToken
  if (updates.deviceToken != null) nextSecret.deviceToken = updates.deviceToken
  return nextSecret
}

export async function loginThingsBoardAccount({
  serverUrl,
  username,
  password,
  fetchImpl = globalThis.fetch,
  validateTarget = assertSafeConnectorTarget,
  timeoutMs = 8_000,
}) {
  return requestTokenPair({
    serverUrl,
    resource: 'login',
    body: { username: String(username || '').trim(), password: String(password || '') },
    fetchImpl,
    validateTarget,
    timeoutMs,
    errorCode: 'THINGSBOARD_LOGIN_FAILED',
  })
}

export async function refreshThingsBoardTokenPair({
  serverUrl,
  refreshToken,
  fetchImpl = globalThis.fetch,
  validateTarget = assertSafeConnectorTarget,
  timeoutMs = 8_000,
}) {
  return requestTokenPair({
    serverUrl,
    resource: 'token',
    body: { refreshToken: String(refreshToken || '') },
    fetchImpl,
    validateTarget,
    timeoutMs,
    errorCode: 'THINGSBOARD_TOKEN_REFRESH_FAILED',
  })
}

export async function getThingsBoardAccessToken({
  connectorId,
  environmentRef = 'staging',
  forceRefresh = false,
  rejectedToken = null,
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  validateTarget = assertSafeConnectorTarget,
  refreshWindowMs = DEFAULT_REFRESH_WINDOW_MS,
}) {
  const environment = await ConnectorEnvironment.findOne({ connectorId, environmentRef }).lean()
  if (!environment?.secretConfiguredAt) throw authError('ThingsBoard authentication is not configured.', 'THINGSBOARD_AUTH_MISSING')
  const secretId = connectorSecretId(connectorId, environmentRef)
  let record = await loadSecret(secretId)
  if (!record) throw authError('ThingsBoard authentication is not configured.', 'THINGSBOARD_AUTH_MISSING')
  let secret = decryptConnectorSecret(record, { connectorId, environmentRef })
  if (!secret.jwt) throw authError('ThingsBoard access JWT is not configured.', 'THINGSBOARD_JWT_MISSING')

  const timestamp = now()
  const expiresAt = thingsBoardJwtExpiresAt(secret.jwt)?.getTime() || null
  const expired = expiresAt != null && expiresAt <= timestamp
  const refreshDue = expiresAt != null && expiresAt <= timestamp + refreshWindowMs
  const anotherRefreshReplacedRejectedToken = forceRefresh && rejectedToken && secret.jwt !== rejectedToken
  if (anotherRefreshReplacedRejectedToken || (!forceRefresh && !refreshDue)) return tokenResult(secret, record)
  if (!secret.refreshToken) {
    if (expired || forceRefresh) throw authError('ThingsBoard JWT expired; reconnect the account or rotate the JWT.', 'THINGSBOARD_JWT_EXPIRED')
    return tokenResult(secret, record)
  }

  const leaseOwner = randomUUID()
  const leaseNow = new Date(timestamp)
  const leased = await ConnectorEnvironment.findOneAndUpdate(
    {
      _id: environment._id,
      $or: [
        { 'authentication.refreshLeaseUntil': null },
        { 'authentication.refreshLeaseUntil': { $exists: false } },
        { 'authentication.refreshLeaseUntil': { $lte: leaseNow } },
      ],
    },
    {
      $set: {
        'authentication.state': 'refreshing',
        'authentication.message': 'Refreshing ThingsBoard JWT.',
        'authentication.lastRefreshAttemptAt': leaseNow,
        'authentication.refreshLeaseOwner': leaseOwner,
        'authentication.refreshLeaseUntil': new Date(timestamp + REFRESH_LEASE_MS),
      },
    },
    { new: true },
  ).lean()

  if (!leased) {
    const refreshedByPeer = await waitForSecretChange({ secretId, previousUpdatedAt: record.updatedAt })
    if (!refreshedByPeer) throw authError('ThingsBoard JWT refresh is already in progress.', 'THINGSBOARD_TOKEN_REFRESH_BUSY')
    const peerSecret = decryptConnectorSecret(refreshedByPeer, { connectorId, environmentRef })
    return tokenResult(peerSecret, refreshedByPeer)
  }

  try {
    record = await loadSecret(secretId)
    secret = decryptConnectorSecret(record, { connectorId, environmentRef })
    const currentExpiry = thingsBoardJwtExpiresAt(secret.jwt)?.getTime() || null
    const alreadyFresh = rejectedToken
      ? secret.jwt !== rejectedToken
      : currentExpiry != null && currentExpiry > now() + refreshWindowMs
    if (alreadyFresh) {
      const observedAt = new Date(now())
      await ConnectorEnvironment.updateOne(
        { _id: environment._id, 'authentication.refreshLeaseOwner': leaseOwner },
        {
          $set: {
            authentication: {
              ...thingsBoardAuthenticationMetadata(secret, { now: observedAt }),
              lastRefreshedAt: environment.authentication?.lastRefreshedAt || null,
              lastRefreshAttemptAt: observedAt,
              refreshLeaseOwner: null,
              refreshLeaseUntil: null,
            },
          },
        },
      )
      return tokenResult(secret, record)
    }

    const pair = await refreshThingsBoardTokenPair({
      serverUrl: environment.config?.serverUrl,
      refreshToken: secret.refreshToken,
      fetchImpl,
      validateTarget,
    })
    const refreshedAt = new Date(now())
    const nextSecret = { ...secret, jwt: pair.token, refreshToken: pair.refreshToken }
    const encrypted = encryptConnectorSecret(nextSecret, { connectorId, environmentRef })
    const updated = await ConnectorSecret.findOneAndUpdate(
      { _id: secretId, updatedAt: record.updatedAt },
      { $set: { ...encrypted, rotatedBy: 'system:thingsboard-refresh' } },
      { new: true },
    ).select(SECRET_FIELDS).lean()
    if (!updated) {
      const raced = await loadSecret(secretId)
      if (!raced) throw authError('ThingsBoard credential update conflicted.', 'THINGSBOARD_TOKEN_REFRESH_CONFLICT')
      const racedSecret = decryptConnectorSecret(raced, { connectorId, environmentRef })
      const observedAt = new Date(now())
      await ConnectorEnvironment.updateOne(
        { _id: environment._id, 'authentication.refreshLeaseOwner': leaseOwner },
        {
          $set: {
            authentication: {
              ...thingsBoardAuthenticationMetadata(racedSecret, { now: observedAt }),
              lastRefreshedAt: observedAt,
              lastRefreshAttemptAt: observedAt,
              refreshLeaseOwner: null,
              refreshLeaseUntil: null,
            },
          },
        },
      )
      return tokenResult(racedSecret, raced)
    }

    const authentication = thingsBoardAuthenticationMetadata(nextSecret, { now: refreshedAt, refreshed: true })
    await ConnectorEnvironment.updateOne(
      { _id: environment._id, 'authentication.refreshLeaseOwner': leaseOwner },
      {
        $set: {
          authentication: {
            ...authentication,
            lastRefreshAttemptAt: refreshedAt,
            refreshLeaseOwner: null,
            refreshLeaseUntil: null,
          },
          secretConfiguredAt: refreshedAt,
        },
      },
    )
    AuditEvent.create({
      workspaceId: environment.workspaceId,
      projectId: environment.projectId,
      actorId: 'system',
      action: 'connector.token.refreshed',
      targetType: 'connector',
      targetId: connectorId,
      metadata: { environmentRef },
    }).catch(() => {})
    return tokenResult(nextSecret, updated)
  } catch (error) {
    const failedAt = new Date(now())
    await ConnectorEnvironment.updateOne(
      { _id: environment._id, 'authentication.refreshLeaseOwner': leaseOwner },
      {
        $set: {
          'authentication.state': 'error',
          'authentication.message': 'JWT refresh failed; reconnect the ThingsBoard account.',
          'authentication.lastRefreshAttemptAt': failedAt,
          'authentication.refreshLeaseOwner': null,
          'authentication.refreshLeaseUntil': null,
        },
      },
    ).catch(() => {})
    if (!expired && !forceRefresh) return tokenResult(secret, record, error)
    throw error
  } finally {
    await ConnectorEnvironment.updateOne(
      { _id: environment._id, 'authentication.refreshLeaseOwner': leaseOwner },
      { $set: { 'authentication.refreshLeaseOwner': null, 'authentication.refreshLeaseUntil': null } },
    ).catch(() => {})
  }
}

export async function withThingsBoardAccessToken(context, operation, { tokenProvider = getThingsBoardAccessToken } = {}) {
  const first = await tokenProvider(context)
  try {
    const result = await operation(first.jwt)
    if (!isAuthenticationRejected(result)) return result
  } catch (error) {
    if (!isAuthenticationRejected(error)) throw error
  }
  const refreshed = await tokenProvider({
    ...context,
    forceRefresh: true,
    rejectedToken: first.jwt,
  })
  return operation(refreshed.jwt)
}

async function requestTokenPair({ serverUrl, resource, body, fetchImpl, validateTarget, timeoutMs, errorCode }) {
  const target = await validateTarget(serverUrl)
  const response = await fetchImpl(`${target}/api/auth/${resource}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw authError('ThingsBoard rejected the authentication request.', errorCode, response.status)
  const pair = await response.json().catch(() => null)
  const token = String(pair?.token || '').trim()
  const refreshToken = String(pair?.refreshToken || '').trim()
  if (!validToken(token) || !validToken(refreshToken)) throw authError('ThingsBoard returned an invalid token pair.', errorCode)
  return { token, refreshToken }
}

async function loadSecret(secretId) {
  return ConnectorSecret.findById(secretId).select(SECRET_FIELDS).lean()
}

async function waitForSecretChange({ secretId, previousUpdatedAt }) {
  const previous = new Date(previousUpdatedAt || 0).getTime()
  const attempts = Math.ceil(REFRESH_WAIT_MS / 100)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const record = await loadSecret(secretId)
    if (record && new Date(record.updatedAt || 0).getTime() !== previous) return record
  }
  return null
}

function tokenResult(secret, record, refreshError = null) {
  return {
    jwt: secret.jwt,
    secret,
    secretUpdatedAt: record?.updatedAt || null,
    refreshError,
  }
}

function isAuthenticationRejected(value) {
  return value?.status === 401 || value?.code === 'HTTP_401' || value?.code === 'THINGSBOARD_UNAUTHORIZED'
}

function validToken(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 16_384
}

function authError(message, code, status = null) {
  const error = new Error(message)
  error.code = code
  if (status != null) error.status = status
  return error
}
