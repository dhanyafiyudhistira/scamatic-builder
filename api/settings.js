import { connectMongo } from './_lib/mongo.js'
import { Settings } from './_lib/models.js'

const VALID_MODES = new Set(['default', 'deck-user'])
const normalizeMode = m => (VALID_MODES.has(m) ? m : 'default')

export default async function handler(req, res) {
  try {
    await connectMongo()

    if (req.method === 'GET') {
      const mode = normalizeMode(req.query.mode)
      let doc = await Settings.findById(mode).lean()
      // Legacy 'global' doc pre-dates per-mode storage; surface it under 'default'.
      if (!doc && mode === 'default') {
        doc = await Settings.findById('global').lean()
      }
      return res.status(200).json(doc ?? {})
    }

    if (req.method === 'POST') {
      const { mode, serverUrl, deviceId, token } = req.body || {}
      const key = normalizeMode(mode)
      await Settings.findByIdAndUpdate(
        key,
        { serverUrl, deviceId, token, updatedAt: new Date() },
        { upsert: true, new: true }
      )
      return res.status(200).json({ ok: true, mode: key })
    }

    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
