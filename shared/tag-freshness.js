export const TAG_FRESHNESS_MODES = Object.freeze(['periodic', 'event-driven'])
export const DEFAULT_STALE_AFTER_MS = 10_000
export const MIN_STALE_AFTER_MS = 1_000
export const MAX_STALE_AFTER_MS = 86_400_000
export const FRESHNESS_SAMPLE_LIMIT = 20
export const FRESHNESS_MIN_SAMPLES = 3

const DISCONNECT_MULTIPLIER = 3
const EXPECTED_TO_STALE_MULTIPLIER = 3
const ADAPTIVE_STALE_CAP_MULTIPLIER = 3

export function normalizeTagFreshness(tag = {}) {
  const staleAfterMs = boundedInteger(tag.staleAfterMs, MIN_STALE_AFTER_MS, MAX_STALE_AFTER_MS, DEFAULT_STALE_AFTER_MS)
  return {
    ...tag,
    freshnessMode: TAG_FRESHNESS_MODES.includes(tag.freshnessMode) ? tag.freshnessMode : 'periodic',
    adaptiveFreshness: typeof tag.adaptiveFreshness === 'boolean' ? tag.adaptiveFreshness : true,
    staleAfterMs,
  }
}

export function tagFreshnessThresholds(tag = {}, observedIntervals = []) {
  const normalized = normalizeTagFreshness(tag)
  if (normalized.freshnessMode === 'event-driven') {
    return {
      mode: 'event-driven',
      adaptive: false,
      sampleCount: 0,
      staleAfterMs: null,
      disconnectAfterMs: null,
    }
  }

  const samples = observedIntervals
    .map(Number)
    .filter(interval => Number.isFinite(interval) && interval > 0)
    .slice(-FRESHNESS_SAMPLE_LIMIT)
  let staleAfterMs = normalized.staleAfterMs
  if (normalized.adaptiveFreshness && samples.length >= FRESHNESS_MIN_SAMPLES) {
    const expectedIntervalMs = percentile95(samples)
    const learnedStaleAfterMs = Math.round(expectedIntervalMs * EXPECTED_TO_STALE_MULTIPLIER)
    const adaptiveCap = Math.min(MAX_STALE_AFTER_MS, normalized.staleAfterMs * ADAPTIVE_STALE_CAP_MULTIPLIER)
    staleAfterMs = clamp(learnedStaleAfterMs, normalized.staleAfterMs, adaptiveCap)
  }

  return {
    mode: 'periodic',
    adaptive: normalized.adaptiveFreshness,
    sampleCount: samples.length,
    staleAfterMs,
    disconnectAfterMs: Math.min(MAX_STALE_AFTER_MS, staleAfterMs * DISCONNECT_MULTIPLIER),
  }
}

export function shouldObserveFreshnessInterval(tag, intervalMs, previousQuality) {
  const policy = tagFreshnessThresholds(tag)
  return policy.mode === 'periodic'
    && policy.adaptive
    && previousQuality !== 'disconnected'
    && Number.isFinite(intervalMs)
    && intervalMs > 0
    && intervalMs <= policy.disconnectAfterMs
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)]
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
