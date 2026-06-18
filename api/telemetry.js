import { connectMongo } from './_lib/mongo.js'
import { Telemetry } from './_lib/models.js'

const DEFAULT_TAGS = 'Level_mix,QI_102,Simulasi_OpeningV104'

export default async function handler(req, res) {
  try {
    await connectMongo()

    if (req.method === 'POST') {
      const { entries } = req.body || {}
      if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(200).json({ ok: true, inserted: 0 })
      }
      const docs = entries.map(e => ({
        tag: e.tag,
        value: e.value,
        timestamp: e.timestamp ? new Date(e.timestamp) : new Date()
      }))
      await Telemetry.insertMany(docs, { ordered: false })
      return res.status(200).json({ ok: true, inserted: docs.length })
    }

    if (req.method === 'GET') {
      const tags    = (req.query.tags || DEFAULT_TAGS).split(',')
      const minutes = parseInt(req.query.minutes || '60', 10)
      const limit   = parseInt(req.query.limit   || '400', 10)
      const since   = new Date(Date.now() - minutes * 60 * 1000)

      const raw = await Telemetry
        .find({ tag: { $in: tags }, timestamp: { $gte: since } })
        .sort({ timestamp: 1 })
        .limit(limit)
        .lean()

      // Pivot: bucket points into 10 s windows so each row has every tag
      // aligned on the same timestamp — chart-friendly shape.
      const buckets = {}
      raw.forEach(({ tag, value, timestamp }) => {
        const key = Math.round(timestamp.getTime() / 10000) * 10000
        if (!buckets[key]) {
          buckets[key] = {
            timestamp: key,
            time: new Date(key).toLocaleTimeString('en-GB', { hour12: false })
          }
        }
        buckets[key][tag] = value
      })

      const rows = Object.values(buckets).sort((a, b) => a.timestamp - b.timestamp)
      return res.status(200).json(rows)
    }

    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
