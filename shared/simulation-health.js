export function initialSimulationBridgeHealth() {
  return {
    telemetry: initialChannelHealth(),
    rpc: initialChannelHealth(),
    lease: { active: true, verified: true, retryAfterMs: 0, expiresAt: null, changedAt: null },
    status: 'online',
  }
}

export function updateSimulationBridgeHealth(current, channel, succeeded, { failureThreshold = 3, errorCode = null, at = Date.now() } = {}) {
  if (!['telemetry', 'rpc'].includes(channel)) throw new TypeError(`Unknown Simulation Bridge channel: ${channel}.`)
  const previous = current || initialSimulationBridgeHealth()
  const priorChannel = previous[channel] || initialChannelHealth()
  const consecutiveFailures = succeeded ? 0 : priorChannel.consecutiveFailures + 1
  const channelState = {
    healthy: succeeded ? true : consecutiveFailures < failureThreshold ? priorChannel.healthy : false,
    consecutiveFailures,
    lastSuccessAt: succeeded ? safeTimestamp(at) : priorChannel.lastSuccessAt || null,
    lastFailureAt: succeeded ? priorChannel.lastFailureAt || null : safeTimestamp(at),
    lastErrorCode: succeeded ? null : safeErrorCode(errorCode),
  }
  const lease = succeeded && channel === 'telemetry' && previous.lease?.active !== false
    ? { ...previous.lease, active: true, verified: true }
    : previous.lease
  const next = { ...previous, [channel]: channelState, lease }
  next.status = simulationBridgeStatus(next)
  return next
}

export function updateSimulationBridgeLease(current, active, { retryAfterMs = 0, expiresAt = null, at = Date.now() } = {}) {
  const previous = current || initialSimulationBridgeHealth()
  const leaseActive = active !== false
  const reacquired = previous.lease?.active === false && leaseActive
  const next = {
    ...previous,
    lease: {
      active: leaseActive,
      verified: leaseActive ? (reacquired ? false : previous.lease?.verified !== false) : false,
      retryAfterMs: leaseActive ? 0 : boundedInteger(retryAfterMs, 0, 60_000, 0),
      expiresAt: safeTimestamp(expiresAt),
      changedAt: safeTimestamp(at),
    },
  }
  next.status = simulationBridgeStatus(next)
  return next
}

export function simulationStandbyRetryDelay(retryAfterMs, { random = Math.random } = {}) {
  const base = boundedInteger(retryAfterMs, 1_000, 30_000, 2_500)
  const jitterWindow = Math.min(1_000, Math.round(base * 0.1))
  const jitter = Math.round(jitterWindow * Math.max(0, Math.min(1, Number(random()) || 0)))
  return Math.max(1_000, base - jitter)
}

export function simulationCommandConnectionAvailable(profile, runtimeState) {
  return profile === 'simulation' || runtimeState === 'online'
}

function simulationBridgeStatus(health) {
  if (health?.lease?.active === false) return 'standby'
  if (!health?.telemetry?.healthy || !health?.rpc?.healthy) return 'degraded'
  if (health?.lease?.verified === false) return 'synchronizing'
  return 'online'
}

function initialChannelHealth() {
  return { healthy: true, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null }
}

function safeErrorCode(value) {
  const code = String(value || 'SIMULATION_BRIDGE_FAILED').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 80)
  return code || 'SIMULATION_BRIDGE_FAILED'
}

function safeTimestamp(value) {
  const timestamp = new Date(value ?? 0)
  return Number.isFinite(timestamp.getTime()) && timestamp.getTime() > 0 ? timestamp.toISOString() : null
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(Math.max(minimum, Math.min(maximum, parsed))) : fallback
}
