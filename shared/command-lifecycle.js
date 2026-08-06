export const TERMINAL_COMMAND_STATUSES = new Set(['acknowledged', 'rejected', 'timeout', 'failed'])
export const PENDING_COMMAND_STATUSES = new Set(['pending', 'requested', 'authorized', 'dispatched', 'accepted_by_gateway'])

export function isTerminalCommandStatus(status) {
  return TERMINAL_COMMAND_STATUSES.has(normalizeCommandStatus(status))
}

export function isPendingCommandStatus(status) {
  return PENDING_COMMAND_STATUSES.has(normalizeCommandStatus(status))
}

export function normalizeCommandStatus(status) {
  return String(status || 'unknown').trim().toLowerCase().replaceAll('-', '_')
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
