import mongoose from 'mongoose'

const MONGO_CONNECT_TIMEOUT_MS = 8000

// Cache the mongoose connection on globalThis so warm Vercel invocations
// (and HMR-driven module reloads in dev) re-use the same TCP/TLS handshake
// instead of paying the 200-500 ms reconnect cost on every request.
const cache = globalThis.__mongoose_cache__ ??= { conn: null, promise: null }

export async function connectMongo() {
  if (cache.conn?.connection?.readyState === 1) return cache.conn

  if (!cache.promise) {
    const existing = cache.conn
    const uri = process.env.MONGO_URI
    if (!existing && !uri) throw new Error('MONGO_URI env var is not set')

    // Sleep can make Mongoose report an established connection as stale.
    // Let the existing driver's server selection recover that connection.
    const operation = existing
      ? existing.connection.db.admin().command({ ping: 1 }, { timeoutMS: MONGO_CONNECT_TIMEOUT_MS }).then(() => existing)
      : mongoose.connect(uri, {
          serverSelectionTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
          connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
        })
    const pending = operation
      .then(connection => {
        if (cache.promise === pending) cache.conn = connection
        return connection
      })
      .finally(() => {
        if (cache.promise === pending) cache.promise = null
      })
    cache.promise = pending
  }

  return cache.promise
}

export async function disconnectMongo() {
  const hasConnection = cache.conn || cache.promise || mongoose.connection?.readyState !== 0
  cache.conn = null
  cache.promise = null
  if (hasConnection) await mongoose.disconnect()
}

export function mongoConnectionStatus() {
  const readyState = Number(mongoose.connection?.readyState ?? 0)
  const labels = ['disconnected', 'connected', 'connecting', 'disconnecting']
  return { ready: readyState === 1, readyState, state: labels[readyState] || 'unknown' }
}

export async function pingMongo({ requireTransactions = false } = {}) {
  const timeoutMs = positiveInteger(process.env.MONGO_READINESS_TIMEOUT_MS, 2500)
  return withMongoDeadline((async () => {
    const connection = await connectMongo()
    await connection.connection.db.admin().command({ ping: 1 })
    const capability = requireTransactions
      ? await assertMongoTransactionsSupported(connection)
      : { transactions: 'not-required' }
    return { ...mongoConnectionStatus(), transactions: capability.transactions }
  })(), timeoutMs)
}

export async function assertMongoTransactionsSupported(connection = null) {
  const activeConnection = connection || await connectMongo()
  const hello = await activeConnection.connection.db.admin().command({ hello: 1 })
  const replicaSet = typeof hello?.setName === 'string' && hello.setName.trim().length > 0
  const shardedCluster = hello?.msg === 'isdbgrid'
  const sessions = Number.isFinite(hello?.logicalSessionTimeoutMinutes)
  const supportedWireVersion = Number(hello?.maxWireVersion) >= (shardedCluster ? 8 : 7)
  if ((!replicaSet && !shardedCluster) || !sessions || !supportedWireVersion) {
    throw mongoTransactionsRequiredError()
  }
  return { topology: shardedCluster ? 'sharded' : 'replica-set', transactions: 'supported' }
}

export function mongoTransactionsRequiredError(cause = null) {
  return Object.assign(
    new Error('MongoDB transactions are required. Configure MongoDB Atlas or a transaction-capable replica set.'),
    { code: 'MONGO_TRANSACTIONS_REQUIRED', statusCode: 503, ...(cause ? { cause } : {}) },
  )
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

export async function runMongoTransaction(work, { requireTransaction = process.env.NODE_ENV === 'production' } = {}) {
  const connection = await connectMongo()
  const session = await connection.startSession()
  try {
    let result
    await session.withTransaction(async () => { result = await work(session) })
    return result
  } catch (error) {
    const unsupported = /Transaction numbers are only allowed|replica set|mongos/i.test(String(error?.message || ''))
    if (!unsupported) throw error
    if (requireTransaction) throw mongoTransactionsRequiredError(error)
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
