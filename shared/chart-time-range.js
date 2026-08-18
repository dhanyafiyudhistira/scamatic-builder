const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const DEFAULT_CHART_TARGET_POINTS = 900
export const MAX_CHART_RANGE_MS = 366 * DAY

export const CHART_RANGE_PRESETS = Object.freeze([
  Object.freeze({ id: '30s', label: '30 s', durationMs: 30 * SECOND }),
  Object.freeze({ id: '1min', label: '1 min', durationMs: MINUTE }),
  Object.freeze({ id: '5min', label: '5 min', durationMs: 5 * MINUTE }),
  Object.freeze({ id: '10min', label: '10 min', durationMs: 10 * MINUTE }),
  Object.freeze({ id: '15min', label: '15 min', durationMs: 15 * MINUTE }),
  Object.freeze({ id: '30min', label: '30 min', durationMs: 30 * MINUTE }),
  Object.freeze({ id: '1h', label: '1 h', durationMs: HOUR }),
  Object.freeze({ id: '6h', label: '6 h', durationMs: 6 * HOUR }),
  Object.freeze({ id: '12h', label: '12 h', durationMs: 12 * HOUR }),
  Object.freeze({ id: '24h', label: '24 h', durationMs: DAY }),
  Object.freeze({ id: '3d', label: '3 d', durationMs: 3 * DAY }),
  Object.freeze({ id: '7d', label: '7 d', durationMs: 7 * DAY }),
  Object.freeze({ id: '1mo', label: '1 mo', durationMs: 30 * DAY }),
  Object.freeze({ id: '3mo', label: '3 mo', durationMs: 90 * DAY }),
  Object.freeze({ id: '6mo', label: '6 mo', durationMs: 180 * DAY }),
  Object.freeze({ id: '1y', label: '1 y', durationMs: 365 * DAY }),
])

const PRESETS = new Map(CHART_RANGE_PRESETS.map(preset => [preset.id, preset]))
const NICE_BUCKETS = Object.freeze([
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
])

export function chartRangePreset(id) {
  return PRESETS.get(String(id || '')) || null
}

export function chartRangeBounds(id, now = Date.now()) {
  const preset = chartRangePreset(id)
  const to = finiteTimestamp(now, Date.now())
  if (!preset) return null
  return { id: preset.id, label: preset.label, from: to - preset.durationMs, to, durationMs: preset.durationMs }
}

export function normalizeChartRange({ from, to, targetPoints } = {}, { now = Date.now() } = {}) {
  const upper = finiteTimestamp(to, now)
  const lower = finiteTimestamp(from, Number.NaN)
  const points = boundedInteger(targetPoints, 300, 2_000, DEFAULT_CHART_TARGET_POINTS)
  if (!Number.isFinite(lower) || lower >= upper) throw new RangeError('Chart history requires a valid from/to range.')
  if (upper > now + 5 * MINUTE) throw new RangeError('Chart history cannot query a future range.')
  const rangeMs = upper - lower
  if (rangeMs > MAX_CHART_RANGE_MS) throw new RangeError('Chart history range cannot exceed 366 days.')
  return { from: new Date(lower), to: new Date(upper), rangeMs, targetPoints: points }
}

export function adaptiveChartResolution(rangeMs, targetPoints = DEFAULT_CHART_TARGET_POINTS) {
  const safeRange = Math.max(SECOND, Number(rangeMs) || SECOND)
  const safeTarget = boundedInteger(targetPoints, 300, 2_000, DEFAULT_CHART_TARGET_POINTS)
  // One visual point carries average plus a min/max envelope, so a bucket can
  // preserve excursions without expanding into several browser-side points.
  const desiredBucketMs = Math.max(SECOND, Math.ceil(safeRange / safeTarget))
  const bucketMs = NICE_BUCKETS.find(candidate => candidate >= desiredBucketMs) || NICE_BUCKETS.at(-1)
  const { unit, binSize } = mongoDateTrunc(bucketMs)
  return { bucketMs, unit, binSize, targetPoints: safeTarget }
}

function mongoDateTrunc(bucketMs) {
  if (bucketMs % DAY === 0) return { unit: 'day', binSize: bucketMs / DAY }
  if (bucketMs % HOUR === 0) return { unit: 'hour', binSize: bucketMs / HOUR }
  if (bucketMs % MINUTE === 0) return { unit: 'minute', binSize: bucketMs / MINUTE }
  return { unit: 'second', binSize: bucketMs / SECOND }
}

function finiteTimestamp(value, fallback) {
  if (value == null || value === '') return fallback
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : fallback
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}
