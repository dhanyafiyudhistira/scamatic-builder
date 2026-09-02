import { commandTimingProjection, isTerminalCommandStatus, normalizeCommandStatus } from '../../shared/command-lifecycle.js'

const TIMING_FIELDS = Object.freeze([
  'apiAuthorizationMs',
  'workerQueueMs',
  'gatewayRpcMs',
  'feedbackWaitMs',
  'upstreamRoundTripMs',
  'terminalProcessingMs',
  'serverTotalMs',
])

export function createRpcPerformanceTracker({ maxSamples = 1_000, now = Date.now } = {}) {
  const capacity = boundedInteger(maxSamples, 10, 10_000, 1_000)
  let samples = []
  let observed = 0
  let latestAt = null
  let cachedSnapshot = null

  return {
    record(event) {
      const status = normalizeCommandStatus(event?.status)
      const timing = commandTimingProjection(event)
      if (!isTerminalCommandStatus(status) || !timing) return false
      const sample = { status, mode: timing.mode || 'unknown' }
      for (const field of TIMING_FIELDS) {
        const value = safeDuration(timing[field])
        if (value != null) sample[field] = value
      }
      if (!TIMING_FIELDS.some(field => sample[field] != null)) return false
      samples.push(sample)
      if (samples.length > capacity) samples = samples.slice(-capacity)
      observed += 1
      latestAt = new Date(safeNow(now)).toISOString()
      cachedSnapshot = null
      return true
    },
    snapshot() {
      if (cachedSnapshot) return cachedSnapshot
      const statuses = Object.fromEntries(['acknowledged', 'rejected', 'timeout', 'failed'].map(status => [
        status,
        samples.filter(sample => sample.status === status).length,
      ]))
      cachedSnapshot = {
        samples: samples.length,
        observed,
        capacity,
        latestAt,
        statuses,
        unverified: statuses.timeout,
        timingMs: Object.fromEntries(TIMING_FIELDS.map(field => [field, summarize(samples.map(sample => sample[field]))])),
      }
      return cachedSnapshot
    },
  }
}

function summarize(values) {
  const sorted = values.map(safeDuration).filter(value => value != null).sort((left, right) => left - right)
  if (!sorted.length) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null }
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1),
  }
}

function percentile(sorted, ratio) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function safeDuration(value) {
  const duration = Number(value)
  return Number.isFinite(duration) && duration >= 0 && duration <= 24 * 60 * 60_000 ? Math.round(duration) : null
}

function safeNow(now) {
  const value = Number(now())
  return Number.isFinite(value) && value >= 0 ? value : Date.now()
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}
