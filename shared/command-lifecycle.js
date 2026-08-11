export const TERMINAL_COMMAND_STATUSES = new Set(['acknowledged', 'rejected', 'timeout', 'failed'])
export const PENDING_COMMAND_STATUSES = new Set(['pending', 'requested', 'authorized', 'dispatched', 'accepted_by_gateway'])
const COMMAND_STATUS_RANK = Object.freeze({
  pending: 0,
  requested: 0,
  authorized: 1,
  dispatched: 2,
  accepted_by_gateway: 3,
  unknown: 3,
  acknowledged: 4,
  rejected: 4,
  timeout: 4,
  failed: 4,
})

export function isTerminalCommandStatus(status) {
  return TERMINAL_COMMAND_STATUSES.has(normalizeCommandStatus(status))
}

export function isPendingCommandStatus(status) {
  return PENDING_COMMAND_STATUSES.has(normalizeCommandStatus(status))
}

export function normalizeCommandStatus(status) {
  return String(status || 'unknown').trim().toLowerCase().replaceAll('-', '_')
}

export function commandStatusRank(status) {
  return COMMAND_STATUS_RANK[normalizeCommandStatus(status)] ?? -1
}

export function commandStatusCanReplace(currentStatus, incomingStatus) {
  const current = normalizeCommandStatus(currentStatus)
  const incoming = normalizeCommandStatus(incomingStatus)
  if (isTerminalCommandStatus(current)) return incoming === current
  return commandStatusRank(incoming) >= commandStatusRank(current)
}

export function commandResultCanReplace(current, incoming) {
  if (!current) return true
  if (!incoming) return false
  if (String(current.requestId || '') === String(incoming.requestId || '')) {
    return commandStatusCanReplace(current.status, incoming.status)
  }
  const currentAt = commandObservedAt(current)
  const incomingAt = commandObservedAt(incoming)
  return !Number.isFinite(currentAt) || !Number.isFinite(incomingAt) || incomingAt >= currentAt
}

export function runtimeCommandProjection(event, replayed = false) {
  const status = normalizeCommandStatus(event?.status)
  return {
    ok: status === 'acknowledged',
    replayed,
    requestId: String(event?.requestId || ''),
    status,
    message: String(event?.resultSummary?.message || status).slice(0, 300),
    code: event?.resultSummary?.code ? String(event.resultSummary.code).slice(0, 120) : null,
    componentId: String(event?.componentId || ''),
    tagId: String(event?.tagId || ''),
    value: event?.resultSummary?.value,
    resetAfterMs: event?.resultSummary?.resetAfterMs || null,
    correlationId: event?.correlationId ? String(event.correlationId).slice(0, 120) : null,
    createdAt: event?.createdAt || null,
    completedAt: event?.completedAt || null,
    timing: commandTimingProjection(event),
  }
}

export function commandTimingProjection(event) {
  const timestamps = {
    received: timestamp(event?.requestReceivedAt || event?.createdAt),
    authorized: timestamp(event?.authorizedAt),
    dispatched: timestamp(event?.dispatchedAt),
    upstreamStarted: timestamp(event?.upstreamStartedAt),
    gatewayAccepted: timestamp(event?.gatewayAcceptedAt),
    upstreamCompleted: timestamp(event?.upstreamCompletedAt),
    completed: timestamp(event?.completedAt),
  }
  const timing = compactObject({
    mode: event?.executionMode === 'mock'
      ? 'simulation'
      : (['two-way', 'feedback-tag'].includes(event?.acknowledgmentMode) ? event.acknowledgmentMode : null),
    apiAuthorizationMs: duration(timestamps.received, timestamps.authorized),
    workerQueueMs: duration(timestamps.authorized, timestamps.dispatched),
    gatewayRpcMs: duration(timestamps.upstreamStarted, timestamps.gatewayAccepted),
    feedbackWaitMs: duration(timestamps.gatewayAccepted, timestamps.upstreamCompleted),
    upstreamRoundTripMs: duration(timestamps.upstreamStarted, timestamps.upstreamCompleted),
    terminalProcessingMs: duration(timestamps.upstreamCompleted, timestamps.completed),
    serverTotalMs: duration(timestamps.received, timestamps.completed),
  })
  return Object.keys(timing).length ? timing : null
}

export function commandStatusPresentation(status) {
  const normalized = normalizeCommandStatus(status)
  if (normalized === 'acknowledged') return { state: 'acknowledged', label: 'ACKNOWLEDGED', tone: 'success' }
  if (normalized === 'rejected') return { state: 'rejected', label: 'REJECTED', tone: 'danger' }
  if (normalized === 'timeout') return { state: 'timeout', label: 'UNVERIFIED / TIMEOUT', tone: 'warning' }
  if (normalized === 'failed') return { state: 'failed', label: 'FAILED', tone: 'danger' }
  if (isPendingCommandStatus(normalized)) return { state: 'pending', label: normalized === 'accepted_by_gateway' ? 'AWAITING FEEDBACK' : 'PENDING', tone: 'pending' }
  return { state: 'unknown', label: 'UNKNOWN', tone: 'warning' }
}

export function commandResultRetentionMs(status) {
  return normalizeCommandStatus(status) === 'acknowledged' ? 12_000 : 15_000
}

// One operator action gets one end-to-end deadline. The API may spend most of
// this budget waiting for gateway/process feedback; the browser only polls for
// whatever time remains instead of starting a second full timeout window.
export function commandCompletionBudgetMs(acknowledgmentTimeoutMs = 5000) {
  const configured = Number(acknowledgmentTimeoutMs)
  const acknowledgment = Number.isFinite(configured) ? Math.max(1000, Math.min(30_000, configured)) : 5000
  return acknowledgment + 5000
}

function commandObservedAt(command) {
  const value = new Date(command?.createdAt || command?.observedAt || 0).getTime()
  return Number.isFinite(value) && value > 0 ? value : Number.NaN
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime()
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function duration(start, end) {
  if (start == null || end == null || end < start) return null
  return Math.round(end - start)
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null))
}
