export const MAX_RUNTIME_HISTORY_POINTS = 2000

export function seedRuntimeHistory(snapshots = {}, persisted = {}) {
  const history = {}
  for (const [tagId, points] of Object.entries(persisted)) {
    if (!Array.isArray(points)) continue
    const normalized = points.map(normalizeTelemetrySample).filter(Boolean).sort((left, right) => left.timestamp - right.timestamp)
    if (normalized.length) history[tagId] = normalized.slice(-MAX_RUNTIME_HISTORY_POINTS)
  }
  for (const [tagId, snapshot] of Object.entries(snapshots)) {
    const sample = normalizeTelemetrySample(snapshot)
    if (!sample) continue
    const current = history[tagId] || []
    const duplicateIndex = current.findIndex(item =>
      sample.sequence != null && item.sequence != null
        ? item.sequence === sample.sequence
        : item.timestamp === sample.timestamp
    )
    if (duplicateIndex >= 0) current[duplicateIndex] = sample
    else current.push(sample)
    current.sort((left, right) => left.timestamp - right.timestamp)
    history[tagId] = current.slice(-MAX_RUNTIME_HISTORY_POINTS)
  }
  return history
}

export function appendRuntimeHistory(previous = {}, events = [], limit = MAX_RUNTIME_HISTORY_POINTS) {
  const safeLimit = Math.max(1, Math.min(MAX_RUNTIME_HISTORY_POINTS, Math.trunc(Number(limit)) || MAX_RUNTIME_HISTORY_POINTS))
  let next = previous
  const touched = new Set()

  for (const event of events) {
    const tagId = typeof event?.tagId === 'string' ? event.tagId : ''
    const sample = normalizeTelemetrySample(event)
    if (!tagId || !sample) continue
    if (next === previous) next = { ...previous }
    const current = touched.has(tagId) ? next[tagId] : [...(previous[tagId] || [])]
    touched.add(tagId)

    const duplicateIndex = current.findIndex(item =>
      sample.sequence != null && item.sequence != null
        ? item.sequence === sample.sequence
        : item.timestamp === sample.timestamp
    )
    if (duplicateIndex >= 0) current[duplicateIndex] = sample
    else current.push(sample)
    current.sort((left, right) => left.timestamp - right.timestamp)
    next[tagId] = current.slice(-safeLimit)
  }
  return next
}

export function normalizeTelemetrySample(sample) {
  const value = Number(sample?.value)
  if (!Number.isFinite(value)) return null
  const timestamp = parseTelemetryTimestamp(sample?.sourceTimestamp ?? sample?.timestamp ?? sample?.receivedAt)
  if (timestamp == null) return null
  return {
    timestamp,
    value,
    quality: typeof sample?.quality === 'string' ? sample.quality : 'good',
    sequence: Number.isFinite(Number(sample?.sequence)) ? Number(sample.sequence) : null,
  }
}

function parseTelemetryTimestamp(value) {
  if (value == null || value === '') return Date.now()
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}
