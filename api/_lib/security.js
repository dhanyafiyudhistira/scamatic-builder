import { createHash, randomUUID } from 'node:crypto'
import { RequestLimit } from './models.js'
import { connectMongo } from './mongo.js'

export function requestId(req) {
  const supplied = String(req.headers?.['x-request-id'] || '')
  return /^[a-zA-Z0-9_-]{8,100}$/.test(supplied) ? supplied : randomUUID()
}

export async function enforceRateLimit(req, res, scope, { limit, windowMs, identity = '', includeSource = true }) {
  await connectMongo()
  const source = includeSource ? clientAddress(req) : 'global'
  const normalizedIdentity = String(identity || '').trim().toLowerCase().slice(0, 200)
  const window = Math.floor(Date.now() / windowMs)
  const key = createHash('sha256').update(`${scope}:${source}:${normalizedIdentity}:${window}`).digest('hex')
  const record = await RequestLimit.findOneAndUpdate(
    { _id: key },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 2) * windowMs) } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean()
  res.setHeader('X-RateLimit-Limit', String(limit))
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - record.count)))
  res.setHeader('RateLimit-Limit', String(limit))
  res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - record.count)))
  if (record.count <= limit) return true
  const retryAfter = Math.max(1, Math.ceil(((window + 1) * windowMs - Date.now()) / 1000))
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
