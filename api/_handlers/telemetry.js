import { connectMongo } from '../_lib/mongo.js'
import { Project } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { enforceRateLimit, requestId } from '../_lib/security.js'
import { readChartTelemetryHistory, writeChartTelemetrySamples } from '../_lib/chart-telemetry-store.js'
import { loadWorkspaceChartStorage } from '../_lib/chart-storage-configuration.js'

const DEFAULT_TAGS = 'Level_mix,QI_102,Simulasi_OpeningV104'
const TAG_PATTERN = /^[a-zA-Z0-9_.:-]{1,120}$/
const MAX_ENTRIES = 1_000

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  const projectId = String(req.query?.projectId || req.body?.projectId || '')
  if (!projectId || projectId.length > 120) return res.status(400).json({ error: 'A valid projectId is required.' })

  try {
    await connectMongo()
    const project = await Project.findById(projectId)
    const permission = req.method === 'POST' ? PERMISSIONS.SOURCE_CONFIGURE : PERMISSIONS.RUNTIME_VIEW
    if (!project || !(await requireProjectPermission(principal, res, project, permission))) return
    const chartStorage = await loadWorkspaceChartStorage(principal.workspaceId)
    const chartConfig = chartStorage.config
    if (!chartConfig.enabled) return res.status(503).json({ error: 'Chart telemetry storage is not configured.', code: 'CHART_STORAGE_DISABLED' })

    if (req.method === 'POST') {
      if (!requireCsrf(req, res, principal)) return
      if (!(await enforceRateLimit(req, res, 'telemetry-write', { limit: 60, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return
      const docs = normalizeTelemetryEntries(req.body?.entries, { workspaceId: principal.workspaceId, projectId })
      if (!docs.length) return res.status(200).json({ ok: true, inserted: 0 })
      const result = await writeChartTelemetrySamples(docs.map((document, index) => ({
        workspaceId: document.workspaceId,
        projectId: document.projectId,
        sourceId: 'legacy-client',
        tagId: document.tag,
        value: document.value,
        sourceTimestamp: document.timestamp,
        receivedAt: new Date(),
        quality: 'good',
        sequence: index,
      })), { config: chartConfig })
      return res.status(200).json({ ok: true, inserted: result.inserted })
    }

    if (req.method === 'GET') {
      if (!(await enforceRateLimit(req, res, 'telemetry-read', { limit: 120, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return
      const { tags, minutes, limit } = normalizeTelemetryQuery(req.query)
      const since   = new Date(Date.now() - minutes * 60 * 1000)

      const history = await readChartTelemetryHistory({
        workspaceId: principal.workspaceId,
        projectId,
        tagIds: tags,
        since,
        limitPerTag: Math.max(1, Math.floor(limit / tags.length)),
      }, { config: chartConfig })

      // Pivot: bucket points into 10 s windows so each row has every tag
      // aligned on the same timestamp — chart-friendly shape.
      const buckets = {}
      Object.entries(history).forEach(([tag, points]) => {
        points.forEach(({ value, timestamp }) => {
          const time = new Date(timestamp)
          const key = Math.round(time.getTime() / 10000) * 10000
          if (!buckets[key]) {
            buckets[key] = {
              timestamp: key,
              time: new Date(key).toLocaleTimeString('en-GB', { hour12: false })
            }
          }
          buckets[key][tag] = value
        })
      })

      const rows = Object.values(buckets).sort((a, b) => a.timestamp - b.timestamp)
      return res.status(200).json(rows)
    }

    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  } catch (error) {
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message })
    if (['CHART_STORAGE_UNAVAILABLE', 'CHART_STORAGE_CONFIGURATION', 'CHART_STORAGE_COLLECTION_TYPE'].includes(error?.code)) {
      return res.status(503).json({ error: 'Chart telemetry storage is temporarily unavailable.', code: error.code, correlationId: requestId(req) })
    }
    return res.status(500).json({ error: 'Unable to process telemetry history.', code: 'TELEMETRY_REQUEST_FAILED', correlationId: requestId(req) })
  }
}

export function normalizeTelemetryQuery(query = {}) {
  const tags = String(query.tags || DEFAULT_TAGS).split(',').map(value => value.trim()).filter(Boolean)
  const minutes = Number.parseInt(String(query.minutes || '60'), 10)
  const limit = Number.parseInt(String(query.limit || '400'), 10)
  if (!tags.length || tags.length > 50 || tags.some(tag => !TAG_PATTERN.test(tag))) throw clientError('Telemetry tags are invalid.')
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080) throw clientError('minutes must be between 1 and 10080.')
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw clientError('limit must be between 1 and 1000.')
  return { tags: [...new Set(tags)], minutes, limit }
}

export function normalizeTelemetryEntries(entries, { workspaceId, projectId, now = Date.now() } = {}) {
  if (entries == null) return []
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw clientError(`entries must be an array containing at most ${MAX_ENTRIES} points.`)
  return entries.map(entry => {
    const tag = String(entry?.tag || '').trim()
    const value = Number(entry?.value)
    const timestamp = entry?.timestamp == null ? new Date(now) : new Date(entry.timestamp)
    if (!TAG_PATTERN.test(tag)) throw clientError('Telemetry entry contains an invalid tag.')
    if (!Number.isFinite(value)) throw clientError('Telemetry entry contains a non-numeric value.')
    const time = timestamp.getTime()
    if (!Number.isFinite(time) || time > now + 5 * 60_000 || time < now - 30 * 24 * 60 * 60_000) throw clientError('Telemetry entry timestamp is outside the accepted window.')
    return { workspaceId, projectId, tag, value, timestamp }
  })
}

function clientError(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}
