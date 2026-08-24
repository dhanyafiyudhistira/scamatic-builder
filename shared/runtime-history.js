export const MAX_RUNTIME_HISTORY_POINTS = 2000
const runtimeHistoryStates = new WeakMap()

export function seedRuntimeHistory(snapshots = {}, persisted = {}) {
  const history = {}
  for (const [tagId, points] of Object.entries(persisted)) {
    if (!Array.isArray(points)) continue
    const normalized = points.map(normalizeTelemetrySample).filter(Boolean).sort((left, right) => left.timestamp - right.timestamp)
    if (normalized.length) {
      history[tagId] = normalized.slice(-MAX_RUNTIME_HISTORY_POINTS)
      rememberRuntimeHistoryState(history[tagId], inspectRuntimeHistory(history[tagId]))
    }
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
    rememberRuntimeHistoryState(history[tagId], inspectRuntimeHistory(history[tagId]))
  }
  return history
}

export function appendRuntimeHistory(previous = {}, events = [], limit = MAX_RUNTIME_HISTORY_POINTS) {
  const safeLimit = Math.max(1, Math.min(MAX_RUNTIME_HISTORY_POINTS, Math.trunc(Number(limit)) || MAX_RUNTIME_HISTORY_POINTS))
  let next = previous
  const touched = new Set()
  const states = new Map()

  for (const event of events) {
    const tagId = typeof event?.tagId === 'string' ? event.tagId : ''
    const sample = normalizeTelemetrySample(event)
    if (!tagId || !sample) continue
    if (next === previous) next = { ...previous }
    const source = previous[tagId] || []
    const current = touched.has(tagId) ? next[tagId] : [...source]
    if (!touched.has(tagId)) {
      touched.add(tagId)
      states.set(tagId, cachedRuntimeHistoryState(source) || inspectRuntimeHistory(current))
    }

    let state = states.get(tagId)
    const latest = current.at(-1)
    const sequenceIsNew = sample.sequence == null
      || state.maximumSequence == null
      || sample.sequence > state.maximumSequence
    const canAppendInOrder = state.sorted
      && (!latest || (sample.timestamp > latest.timestamp && sequenceIsNew))

    if (canAppendInOrder) {
      current.push(sample)
      if (sample.sequence != null && (state.maximumSequence == null || sample.sequence > state.maximumSequence)) {
        state.maximumSequence = sample.sequence
      }
    } else {
      const duplicateIndex = current.findIndex(item =>
        sample.sequence != null && item.sequence != null
          ? item.sequence === sample.sequence
          : item.timestamp === sample.timestamp
      )
      if (duplicateIndex >= 0) current[duplicateIndex] = sample
      else current.push(sample)
      current.sort((left, right) => left.timestamp - right.timestamp)
      state = inspectRuntimeHistory(current)
      states.set(tagId, state)
    }
    const output = current.length > safeLimit ? current.slice(-safeLimit) : current
    next[tagId] = output
    rememberRuntimeHistoryState(output, state)
  }
  return next
}

function inspectRuntimeHistory(points) {
  let sorted = true
  let previousTimestamp = -Infinity
  let maximumSequence = null
  for (const point of points) {
    const timestamp = Number(point?.timestamp)
    if (!Number.isFinite(timestamp) || timestamp < previousTimestamp) sorted = false
    if (Number.isFinite(timestamp)) previousTimestamp = timestamp
    const sequence = Number(point?.sequence)
    if (point?.sequence != null && Number.isFinite(sequence) && (maximumSequence == null || sequence > maximumSequence)) {
      maximumSequence = sequence
    }
  }
  return { sorted, maximumSequence }
}

function cachedRuntimeHistoryState(points) {
  if (!Array.isArray(points)) return null
  const cached = runtimeHistoryStates.get(points)
  if (!cached
    || cached.length !== points.length
    || cached.firstTimestamp !== points[0]?.timestamp
    || cached.lastTimestamp !== points.at(-1)?.timestamp) return null
  return { sorted: cached.sorted, maximumSequence: cached.maximumSequence }
}

function rememberRuntimeHistoryState(points, state) {
  runtimeHistoryStates.set(points, {
    sorted: state.sorted,
    maximumSequence: state.maximumSequence,
    length: points.length,
    firstTimestamp: points[0]?.timestamp,
    lastTimestamp: points.at(-1)?.timestamp,
  })
}

export function normalizeTelemetrySample(sample) {
  const value = Number(sample?.value)
  if (!Number.isFinite(value)) return null
  const timestamp = parseTelemetryTimestamp(sample?.sourceTimestamp ?? sample?.timestamp ?? sample?.receivedAt)
  if (timestamp == null) return null
  const normalized = {
    timestamp,
    value,
    quality: typeof sample?.quality === 'string' ? sample.quality : 'good',
    sequence: Number.isFinite(Number(sample?.sequence)) ? Number(sample.sequence) : null,
  }
  for (const field of ['first', 'last', 'min', 'max']) {
    const fieldValue = Number(sample?.[field])
    if (Number.isFinite(fieldValue)) normalized[field] = fieldValue
  }
  const count = Number(sample?.count)
  const resolutionMs = Number(sample?.resolutionMs)
  if (Number.isInteger(count) && count > 0) normalized.count = count
  if (Number.isFinite(resolutionMs) && resolutionMs > 0) normalized.resolutionMs = resolutionMs
  return normalized
}

function parseTelemetryTimestamp(value) {
  if (value == null || value === '') return Date.now()
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}
