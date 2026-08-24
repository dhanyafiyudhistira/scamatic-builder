import { COMMAND_PHASE_TIMING_FIELDS } from './command-phase-timing.js'

const RECORDABLE_STATUSES = new Set(['acknowledged', 'rejected', 'timeout', 'failed', 'unknown'])
const TIMING_FIELDS = Object.freeze([
  'apiAuthorizationMs',
  'workerQueueMs',
  'gatewayRpcMs',
  'upstreamRoundTripMs',
  'feedbackWaitMs',
  'serverTotalMs',
  ...COMMAND_PHASE_TIMING_FIELDS,
  'clientEndToEndMs',
])

export const DEFAULT_RUNTIME_COMMAND_METRICS_CAPACITY = 1_000

export function runtimeCommandMetricsStorageKey(projectId, versionId) {
  return `scada.runtime-command-metrics.v1:${encodeURIComponent(String(projectId || 'unknown'))}:${encodeURIComponent(String(versionId || 'unknown'))}`
}

export function createRuntimeCommandMetricsRecorder({
  storage = null,
  storageKey = runtimeCommandMetricsStorageKey(),
  maxSamples = DEFAULT_RUNTIME_COMMAND_METRICS_CAPACITY,
  persistDelayMs = 100,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const capacity = boundedInteger(maxSamples, 10, 5_000, DEFAULT_RUNTIME_COMMAND_METRICS_CAPACITY)
  const restored = readStoredMetrics(storage, storageKey, capacity)
  let samples = restored.samples
  let maxInFlight = restored.maxInFlight
  let starts = new Map()
  let persistTimer = null

  const schedulePersist = () => {
    if (!storage || persistTimer) return
    persistTimer = setTimer(() => {
      persistTimer = null
      writeStoredMetrics(storage, storageKey, { maxInFlight, samples })
    }, Math.max(0, Number(persistDelayMs) || 0))
    persistTimer?.unref?.()
  }

  const flush = () => {
    if (persistTimer) clearTimer(persistTimer)
    persistTimer = null
    return writeStoredMetrics(storage, storageKey, { maxInFlight, samples })
  }

  return {
    start(requestId, { startedAt = now() } = {}) {
      const id = safeIdentifier(requestId)
      const timestamp = finiteTimestamp(startedAt)
      if (!id || timestamp == null || starts.has(id)) return false
      starts.set(id, timestamp)
      while (starts.size > capacity) starts.delete(starts.keys().next().value)
      maxInFlight = Math.max(maxInFlight, starts.size)
      return true
    },
    record(result, { recordedAt = now() } = {}) {
      const requestId = safeIdentifier(result?.requestId)
      const status = normalizeStatus(result?.status)
      const existingIndex = samples.findIndex(sample => sample.requestId === requestId)
      if (!requestId || !RECORDABLE_STATUSES.has(status) || (existingIndex < 0 && !starts.has(requestId))) return false

      const start = starts.get(requestId)
      starts.delete(requestId)
      const sample = commandMetricSample(result, { requestId, status, start, recordedAt })
      if (existingIndex >= 0) samples[existingIndex] = mergeMetricSamples(samples[existingIndex], sample)
      else samples.push(sample)
      if (samples.length > capacity) samples = samples.slice(-capacity)
      schedulePersist()
      return true
    },
    abandon(requestId) {
      return starts.delete(safeIdentifier(requestId))
    },
    summary() {
      return runtimeCommandMetricsSummary(samples, { capacity, inFlight: starts.size, maxInFlight })
    },
    samples() {
      return samples.map(sample => ({ ...sample }))
    },
    reset() {
      if (persistTimer) clearTimer(persistTimer)
      persistTimer = null
      samples = []
      starts = new Map()
      maxInFlight = 0
      try { storage?.removeItem?.(storageKey) } catch {}
      return runtimeCommandMetricsSummary(samples, { capacity, inFlight: 0, maxInFlight: 0 })
    },
    flush,
  }
}

export function runtimeCommandMetricsSummary(samples = [], { capacity = DEFAULT_RUNTIME_COMMAND_METRICS_CAPACITY, inFlight = 0, maxInFlight = 0 } = {}) {
  const safeSamples = Array.isArray(samples) ? samples.map(normalizeStoredSample).filter(Boolean) : []
  const statuses = Object.fromEntries(['acknowledged', 'rejected', 'timeout', 'failed', 'unknown'].map(status => [status, safeSamples.filter(sample => sample.status === status).length]))
  const unverified = statuses.timeout + statuses.unknown
  return {
    count: safeSamples.length,
    capacity,
    inFlight: nonNegativeInteger(inFlight),
    maxInFlight: nonNegativeInteger(maxInFlight),
    statuses,
    acknowledgedRate: percentage(statuses.acknowledged, safeSamples.length),
    unverified,
    unverifiedRate: percentage(unverified, safeSamples.length),
    metrics: Object.fromEntries(TIMING_FIELDS.map(field => [field, summarizeValues(safeSamples.map(sample => sample[field]))])),
  }
}

export function runtimeCommandMetricsCsv(samples = []) {
  const fields = ['requestId', 'observedAt', 'status', 'mode', ...TIMING_FIELDS]
  const rows = (Array.isArray(samples) ? samples : []).map(normalizeStoredSample).filter(Boolean)
  return [fields.join(','), ...rows.map(row => fields.map(field => csvCell(row[field])).join(','))].join('\r\n')
}

function commandMetricSample(result, { requestId, status, start, recordedAt }) {
  const timing = result?.timing && typeof result.timing === 'object' ? result.timing : {}
  const finishedAt = finiteTimestamp(recordedAt) ?? Date.now()
  const sample = {
    requestId,
    observedAt: safeDate(result?.completedAt || result?.observedAt, finishedAt),
    status,
    mode: safeMode(timing.mode),
  }
  for (const field of TIMING_FIELDS) {
    if (field === 'clientEndToEndMs') continue
    const value = safeDuration(timing[field])
    if (value != null) sample[field] = value
  }
  if (start != null && finishedAt >= start) sample.clientEndToEndMs = Math.round(finishedAt - start)
  return sample
}

function mergeMetricSamples(current, incoming) {
  const merged = { ...current, ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value != null && value !== '')) }
  if (current.clientEndToEndMs != null) merged.clientEndToEndMs = current.clientEndToEndMs
  return merged
}

function summarizeValues(values) {
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

function readStoredMetrics(storage, storageKey, capacity) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(storageKey) || 'null')
    const samples = Array.isArray(parsed?.samples) ? parsed.samples.map(normalizeStoredSample).filter(Boolean).slice(-capacity) : []
    return { samples, maxInFlight: nonNegativeInteger(parsed?.maxInFlight) }
  } catch {
    return { samples: [], maxInFlight: 0 }
  }
}

function writeStoredMetrics(storage, storageKey, state) {
  if (!storage?.setItem) return false
  try {
    storage.setItem(storageKey, JSON.stringify({ version: 1, maxInFlight: nonNegativeInteger(state.maxInFlight), samples: state.samples }))
    return true
  } catch {
    return false
  }
}

function normalizeStoredSample(value) {
  const requestId = safeIdentifier(value?.requestId)
  const status = normalizeStatus(value?.status)
  if (!requestId || !RECORDABLE_STATUSES.has(status)) return null
  const sample = {
    requestId,
    observedAt: safeDate(value?.observedAt, 0),
    status,
    mode: safeMode(value?.mode),
  }
  for (const field of TIMING_FIELDS) {
    const duration = safeDuration(value?.[field])
    if (duration != null) sample[field] = duration
  }
  return sample
}

function safeDuration(value) {
  const duration = Number(value)
  return Number.isFinite(duration) && duration >= 0 && duration <= 24 * 60 * 60 * 1_000 ? Math.round(duration) : null
}

function safeIdentifier(value) {
  return String(value || '').trim().slice(0, 120)
}

function safeMode(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40)
}

function normalizeStatus(value) {
  return String(value || 'unknown').trim().toLowerCase().replaceAll('-', '_')
}

function safeDate(value, fallback) {
  const timestamp = finiteTimestamp(value) ?? finiteTimestamp(fallback) ?? 0
  return timestamp > 0 ? new Date(timestamp).toISOString() : ''
}

function finiteTimestamp(value) {
  if (value == null || value === '') return null
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime()
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null
}

function percentage(count, total) {
  return total > 0 ? Math.round((count / total) * 10_000) / 100 : 0
}

function nonNegativeInteger(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function csvCell(value) {
  if (value == null) return ''
  const raw = String(value)
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
