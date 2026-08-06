export function initialSimulationBridgeHealth() {
  return {
    telemetry: { healthy: true, consecutiveFailures: 0 },
    rpc: { healthy: true, consecutiveFailures: 0 },
    status: 'online',
  }
}

export function updateSimulationBridgeHealth(current, channel, succeeded, { failureThreshold = 3 } = {}) {
  if (!['telemetry', 'rpc'].includes(channel)) throw new TypeError(`Unknown Simulation Bridge channel: ${channel}.`)
  const previous = current || initialSimulationBridgeHealth()
  const priorChannel = previous[channel] || { healthy: true, consecutiveFailures: 0 }
  const consecutiveFailures = succeeded ? 0 : priorChannel.consecutiveFailures + 1
  const channelState = {
    healthy: succeeded ? true : consecutiveFailures < failureThreshold ? priorChannel.healthy : false,
    consecutiveFailures,
  }
  const next = { ...previous, [channel]: channelState }
  next.status = next.telemetry.healthy && next.rpc.healthy ? 'online' : 'degraded'
  return next
}

export function simulationCommandConnectionAvailable(profile, runtimeState) {
  return profile === 'simulation' || runtimeState === 'online'
}
