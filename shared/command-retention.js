const DAY_MS = 24 * 60 * 60 * 1000

export const RETENTION_ELIGIBLE_STATUSES = Object.freeze(['acknowledged', 'rejected', 'failed'])
export const RETENTION_ACTIVE_STATUSES = Object.freeze(['requested', 'authorized', 'dispatched', 'accepted_by_gateway'])
export const RETENTION_LIVE_EXECUTION_MODES = Object.freeze(['serverless', 'worker'])

export function commandRetentionPolicy(environment = process.env) {
  return Object.freeze({
    enabled: environment.COMMAND_RETENTION_ENABLED === 'true',
    acknowledgedDays: boundedInteger(environment.COMMAND_RETENTION_ACK_DAYS, 30, 3650, 90),
    failureDays: boundedInteger(environment.COMMAND_RETENTION_FAILURE_DAYS, 30, 3650, 90),
    batchSize: boundedInteger(environment.COMMAND_RETENTION_BATCH_SIZE, 10, 500, 100),
    intervalMs: boundedInteger(environment.COMMAND_RETENTION_INTERVAL_MS, 60_000, 86_400_000, 600_000),
    initialDelayMs: boundedInteger(environment.COMMAND_RETENTION_INITIAL_DELAY_MS, 10_000, 86_400_000, 60_000),
    leaseMs: boundedInteger(environment.COMMAND_RETENTION_LEASE_MS, 30_000, 600_000, 120_000),
    queryMaxTimeMs: boundedInteger(environment.COMMAND_RETENTION_QUERY_MAX_TIME_MS, 500, 30_000, 5_000),
    stateRecheckMs: boundedInteger(environment.COMMAND_RETENTION_STATE_RECHECK_MS, 86_400_000, 7_776_000_000, 2_592_000_000),
  })
}

export function commandRetentionDays(status, policy = commandRetentionPolicy()) {
  if (status === 'acknowledged') return policy.acknowledgedDays
  if (status === 'rejected' || status === 'failed') return policy.failureDays
  return null
}

export function commandPurgeAt(event, {
  policy = commandRetentionPolicy(),
} = {}) {
  if (!policy.enabled || !event || event.terminalAuditPending === true) return null
  if (!RETENTION_ELIGIBLE_STATUSES.includes(event.status)) return null
  if (!RETENTION_LIVE_EXECUTION_MODES.includes(event.executionMode)) return null
  const completedAt = validDate(event.completedAt)
  const retentionDays = commandRetentionDays(event.status, policy)
  if (!completedAt || !retentionDays) return null
  return new Date(completedAt.getTime() + retentionDays * DAY_MS)
}

export function commandRetentionCutoff(status, {
  policy = commandRetentionPolicy(),
  now = new Date(),
} = {}) {
  const retentionDays = commandRetentionDays(status, policy)
  const current = validDate(now)
  if (!policy.enabled || !retentionDays || !current) return null
  return new Date(current.getTime() - retentionDays * DAY_MS)
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value || 0)
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}
