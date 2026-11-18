import { mongoConnectionStatus, pingMongo } from '../_lib/mongo.js'
import { requestId } from '../_lib/security.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  const ts = Date.now()
  const readiness = req.query?.readiness === '1' || req.query?.check === 'readiness'
  if (!readiness) return res.status(200).json({ ok: true, status: 'alive', ts })
  const correlationId = requestId(req)
  try {
    const mongo = await pingMongo({ requireTransactions: process.env.NODE_ENV === 'production' })
    return res.status(200).json({ ok: true, status: 'ready', ts, checks: { mongo: mongo.state, transactions: mongo.transactions }, correlationId })
  } catch (error) {
    const mongo = mongoConnectionStatus()
    const transactionsRequired = error?.code === 'MONGO_TRANSACTIONS_REQUIRED'
    return res.status(503).json({
      ok: false,
      status: 'not-ready',
      ts,
      checks: { mongo: mongo.state, transactions: transactionsRequired ? 'unsupported' : 'unknown' },
      code: transactionsRequired ? error.code : 'DATABASE_UNAVAILABLE',
      ...(transactionsRequired ? { error: error.message } : {}),
      correlationId,
    })
  }
}
