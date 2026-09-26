import { createHash, randomUUID } from 'node:crypto'
import { RequestLimit } from './models.js'
import { connectMongo } from './mongo.js'

const RATE_LIMIT_LEASE_CACHE_MAX = 2048
const rateLimitLeases = new Map()
const rateLimitRefills = new Map()

export function requestId(req) {
  const supplied = String(req.headers?.['x-request-id'] || '')
  return /^[a-zA-Z0-9_-]{8,100}$/.test(supplied) ? supplied : randomUUID()
}

export async function enforceRateLimit(req, res, scope, { limit, windowMs, identity = '', includeSource = true, leaseSize = 1 }) {
  const source = includeSource ? clientAddress(req) : 'global'
  const normalizedIdentity = String(identity || '').trim().toLowerCase().slice(0, 200)
  const now = Date.now()
  const window = Math.floor(now / windowMs)
  const windowExpiresAt = (window + 1) * windowMs
  const key = createHash('sha256').update(`${scope}:${source}:${normalizedIdentity}:${window}`).digest('hex')
  const reservationSize = Math.max(1, Math.min(limit, Number.isInteger(Number(leaseSize)) ? Number(leaseSize) : 1))
  const leased = consumeRateLimitLease(key, now)
  if (leased) {
    setRateLimitHeaders(res, limit, leased.remaining)
    if (leased.allowed) {
      scheduleRateLimitLeaseRefill({ key, limit, reservationSize, windowExpiresAt, windowMs, now })
      return true
    }
    return rejectRateLimited(res, windowExpiresAt, now)
  }

  const pendingRefill = rateLimitRefills.get(key)
  if (pendingRefill) {
    await pendingRefill
    const prefetched = consumeRateLimitLease(key, Date.now())
    if (prefetched) {
      setRateLimitHeaders(res, limit, prefetched.remaining)
      if (prefetched.allowed) {
        scheduleRateLimitLeaseRefill({ key, limit, reservationSize, windowExpiresAt, windowMs, now: Date.now() })
        return true
      }
      return rejectRateLimited(res, windowExpiresAt, Date.now())
    }
  }

  const record = await reserveRateLimitLease({ key, reservationSize, window, windowMs })
  const grant = reservedRateLimitGrant({ recordCount: record.count, reservationSize, limit })
  if (grant.granted > 0) {
    const locallyRemaining = grant.granted - 1
    const reportedRemaining = Math.max(0, limit - Number(record.count || 0)) + locallyRemaining
    if (locallyRemaining > 0) storeRateLimitLease(key, { allowed: true, remaining: locallyRemaining, reportedRemaining, expiresAt: windowExpiresAt }, now)
    setRateLimitHeaders(res, limit, reportedRemaining)
    return true
  }
  storeRateLimitLease(key, { allowed: false, remaining: 0, reportedRemaining: 0, expiresAt: windowExpiresAt }, now)
  setRateLimitHeaders(res, limit, 0)
  return rejectRateLimited(res, windowExpiresAt, now)
}

export function reservedRateLimitGrant({ recordCount, reservationSize, limit }) {
  const reserved = Math.max(1, Number(reservationSize) || 1)
  const ceiling = Math.max(0, Number(limit) || 0)
  const count = Math.max(0, Number(recordCount) || 0)
  const countBeforeReservation = Math.max(0, count - reserved)
  return { granted: Math.max(0, Math.min(reserved, ceiling - countBeforeReservation)) }
}

function consumeRateLimitLease(key, now) {
  const lease = rateLimitLeases.get(key)
  if (!lease) return null
  if (lease.expiresAt <= now) {
    rateLimitLeases.delete(key)
    return null
  }
  if (!lease.allowed) return { allowed: false, remaining: 0 }
  if (lease.remaining <= 0) return lease.exhausted ? { allowed: false, remaining: 0 } : null
  lease.remaining -= 1
  lease.reportedRemaining = Math.max(0, lease.reportedRemaining - 1)
  return { allowed: true, remaining: lease.reportedRemaining, localRemaining: lease.remaining }
}

function scheduleRateLimitLeaseRefill({ key, limit, reservationSize, windowExpiresAt, windowMs, now }) {
  if (reservationSize <= 1 || rateLimitRefills.has(key)) return false
  const lease = rateLimitLeases.get(key)
  if (!lease?.allowed || lease.exhausted || lease.expiresAt <= now || lease.remaining > rateLimitLeaseRefillThreshold(reservationSize)) return false
  // The current fixed-window key already contains the window identity. Only
  // the expiry value matters to MongoDB here, so derive a stable cleanup date
  // without delaying the caller on this replenishment.
  const refill = reserveRateLimitLeaseForExpiry({ key, reservationSize, expiresAt: new Date(windowExpiresAt + windowMs) })
    .then(record => {
      const current = rateLimitLeases.get(key)
      if (!current || current.expiresAt <= Date.now()) return
      const merged = mergeRateLimitLeaseGrant(current, { recordCount: record.count, reservationSize, limit })
      storeRateLimitLease(key, { ...current, ...merged }, Date.now())
    })
    .catch(() => null)
    .finally(() => rateLimitRefills.delete(key))
  rateLimitRefills.set(key, refill)
  return true
}

export function rateLimitLeaseRefillThreshold(reservationSize) {
  const size = Math.max(1, Number(reservationSize) || 1)
  return Math.max(1, Math.ceil(size / 4))
}

export function mergeRateLimitLeaseGrant(lease, { recordCount, reservationSize, limit }) {
  const grant = reservedRateLimitGrant({ recordCount, reservationSize, limit })
  const existing = Math.max(0, Number(lease?.remaining) || 0)
  const remaining = existing + grant.granted
  if (remaining <= 0) return { allowed: false, exhausted: true, remaining: 0, reportedRemaining: 0 }
  return {
    allowed: true,
    exhausted: grant.granted <= 0,
    remaining,
    reportedRemaining: Math.max(0, Number(limit) - Number(recordCount || 0)) + remaining,
  }
}

async function reserveRateLimitLease({ key, reservationSize, window, windowMs }) {
  return reserveRateLimitLeaseForExpiry({ key, reservationSize, expiresAt: new Date((window + 2) * windowMs) })
}

async function reserveRateLimitLeaseForExpiry({ key, reservationSize, expiresAt }) {
  await connectMongo()
  return RequestLimit.findOneAndUpdate(
    { _id: key },
    { $inc: { count: reservationSize }, $setOnInsert: { expiresAt } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean()
}

function storeRateLimitLease(key, lease, now) {
  if (rateLimitLeases.size >= RATE_LIMIT_LEASE_CACHE_MAX) {
    for (const [candidate, entry] of rateLimitLeases) {
      if (entry.expiresAt <= now) rateLimitLeases.delete(candidate)
    }
  }
  while (rateLimitLeases.size >= RATE_LIMIT_LEASE_CACHE_MAX) {
    const oldest = rateLimitLeases.keys().next().value
    if (oldest == null) break
    rateLimitLeases.delete(oldest)
  }
  rateLimitLeases.set(key, lease)
}

function setRateLimitHeaders(res, limit, remaining) {
  res.setHeader('X-RateLimit-Limit', String(limit))
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)))
  res.setHeader('RateLimit-Limit', String(limit))
  res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)))
}

function rejectRateLimited(res, windowExpiresAt, now) {
  const retryAfter = Math.max(1, Math.ceil((windowExpiresAt - now) / 1000))
  res.setHeader('Retry-After', String(retryAfter))
  res.setHeader('RateLimit-Reset', String(retryAfter))
  res.status(429).json({ error: 'Too many requests. Try again later.', code: 'RATE_LIMITED' })
  return false
}

export function clientAddress(req = {}) {
  const candidate = req.ip
    || req.headers?.['x-real-ip']
    || String(req.headers?.['x-forwarded-for'] || '').split(',')[0]
    || req.socket?.remoteAddress
    || 'unknown'
  return String(candidate).trim().slice(0, 100) || 'unknown'
}

export function isDatabaseUnavailableError(error) {
  let current = error
  for (let depth = 0; current && depth < 4; depth += 1) {
    const name = String(current.name || '')
    const code = String(current.code || '')
    const message = String(current.message || '')
    if (/MongooseServerSelectionError|MongoNetworkError|MongoServerSelectionError/i.test(name)) return true
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|querySrv|buffering timed out|server selection|MONGO_READINESS_TIMEOUT/i.test(`${code} ${message}`)) return true
    current = current.cause
  }
  return false
}

export function publicError(res, status, message, code, correlationId = null) {
  return res.status(status).json({ error: message, ...(code ? { code } : {}), ...(correlationId ? { correlationId } : {}) })
}

export function redactMetadata(value, depth = 0) {
  if (depth > 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redactMetadata(item, depth + 1))
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 500) : value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|secret|token|credential|authorization/i.test(key)).slice(0, 30).map(([key, item]) => [key, redactMetadata(item, depth + 1)]))
}
