import mongoose from 'mongoose'

// Cache the mongoose connection on globalThis so warm Vercel invocations
// (and HMR-driven module reloads in dev) re-use the same TCP/TLS handshake
// instead of paying the 200-500 ms reconnect cost on every request.
const cache = globalThis.__mongoose_cache__ ??= { conn: null, promise: null }

export async function connectMongo() {
  if (cache.conn?.connection?.readyState === 1) return cache.conn
  if (cache.conn) {
    cache.conn = null
    cache.promise = null
  }

  const uri = process.env.MONGO_URI
  if (!uri) throw new Error('MONGO_URI env var is not set')

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 })
      .catch(err => {
        // Reset promise so the next call can retry instead of returning
        // a permanently-rejected promise.
        cache.promise = null
        throw err
      })
  }

  cache.conn = await cache.promise
  return cache.conn
}

export async function disconnectMongo() {
  cache.conn = null
  cache.promise = null
  if (mongoose.connection?.readyState !== 0) await mongoose.disconnect()
}

export function mongoConnectionStatus() {
  const readyState = Number(mongoose.connection?.readyState ?? 0)
  const labels = ['disconnected', 'connected', 'connecting', 'disconnecting']
  return { ready: readyState === 1, readyState, state: labels[readyState] || 'unknown' }
}

export async function pingMongo() {
  const timeoutMs = positiveInteger(process.env.MONGO_READINESS_TIMEOUT_MS, 2500)
  return withMongoDeadline((async () => {
    const connection = await connectMongo()
    await connection.connection.db.admin().command({ ping: 1 })
    return mongoConnectionStatus()
  })(), timeoutMs)
}

export async function withMongoDeadline(operation, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`MongoDB readiness check exceeded ${timeoutMs} ms`)
          error.name = 'MongoReadinessTimeoutError'
          error.code = 'MONGO_READINESS_TIMEOUT'
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function runMongoTransaction(work) {
  const connection = await connectMongo()
  const session = await connection.startSession()
  try {
    let result
    await session.withTransaction(async () => { result = await work(session) })
    return result
  } catch (error) {
    const unsupported = /Transaction numbers are only allowed|replica set|mongos/i.test(String(error?.message || ''))
    if (!unsupported || process.env.NODE_ENV === 'production') throw error
    // Local standalone MongoDB fallback. Production intentionally fails closed
    // unless a replica set/transaction-capable cluster is configured.
    return work(null)
  } finally {
    await session.endSession()
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
