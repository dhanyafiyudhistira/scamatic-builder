import mongoose from 'mongoose'

// Cache the mongoose connection on globalThis so warm Vercel invocations
// (and HMR-driven module reloads in dev) re-use the same TCP/TLS handshake
// instead of paying the 200-500 ms reconnect cost on every request.
const cache = globalThis.__mongoose_cache__ ??= { conn: null, promise: null }

export async function connectMongo() {
  if (cache.conn) return cache.conn

  const uri = process.env.MONGO_URI
  if (!uri) throw new Error('MONGO_URI env var is not set')

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(uri, { serverSelectionTimeoutMS: 8000 })
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
