import test from 'node:test'
import assert from 'node:assert/strict'
import {
  initialSimulationBridgeHealth,
  simulationCommandConnectionAvailable,
  simulationStandbyRetryDelay,
  updateSimulationBridgeHealth,
  updateSimulationBridgeLease,
} from '../shared/simulation-health.js'

test('one transient bridge failure does not flap the Simulation runtime offline', () => {
  const initial = initialSimulationBridgeHealth()
  const firstFailure = updateSimulationBridgeHealth(initial, 'telemetry', false)
  const secondFailure = updateSimulationBridgeHealth(firstFailure, 'telemetry', false)
  assert.equal(firstFailure.status, 'online')
  assert.equal(secondFailure.status, 'online')
  const sustainedFailure = updateSimulationBridgeHealth(secondFailure, 'telemetry', false)
  assert.equal(sustainedFailure.status, 'degraded')
})

test('one channel recovery cannot hide a sustained failure in the other channel', () => {
  let health = initialSimulationBridgeHealth()
  health = updateSimulationBridgeHealth(health, 'telemetry', false)
  health = updateSimulationBridgeHealth(health, 'telemetry', false)
  health = updateSimulationBridgeHealth(health, 'telemetry', false)
  health = updateSimulationBridgeHealth(health, 'rpc', true)
  assert.equal(health.status, 'degraded')
  health = updateSimulationBridgeHealth(health, 'telemetry', true)
  assert.equal(health.status, 'online')
})

test('Simulation controls remain locally available while the bridge reconnects', () => {
  assert.equal(simulationCommandConnectionAvailable('simulation', 'degraded'), true)
  assert.equal(simulationCommandConnectionAvailable('simulation', 'standby'), true)
  assert.equal(simulationCommandConnectionAvailable('real', 'degraded'), false)
  assert.equal(simulationCommandConnectionAvailable('real', 'online'), true)
})

test('standby is distinct from degradation and requires real channel recovery after reacquiring the lease', () => {
  let health = initialSimulationBridgeHealth()
  health = updateSimulationBridgeHealth(health, 'telemetry', false, { errorCode: 'HTTP_503', at: 1_000 })
  health = updateSimulationBridgeHealth(health, 'telemetry', false, { errorCode: 'HTTP_503', at: 2_000 })
  health = updateSimulationBridgeHealth(health, 'telemetry', false, { errorCode: 'HTTP_503', at: 3_000 })
  assert.equal(health.status, 'degraded')
  assert.equal(health.telemetry.lastErrorCode, 'HTTP_503')

  health = updateSimulationBridgeLease(health, false, { retryAfterMs: 35_000, expiresAt: 40_000, at: 4_000 })
  assert.equal(health.status, 'standby')
  assert.equal(health.lease.retryAfterMs, 35_000)
  health = updateSimulationBridgeHealth(health, 'rpc', true, { at: 5_000 })
  assert.equal(health.status, 'standby')

  health = updateSimulationBridgeLease(health, true, { at: 6_000 })
  assert.equal(health.status, 'degraded')
  health = updateSimulationBridgeHealth(health, 'telemetry', true, { at: 7_000 })
  assert.equal(health.status, 'online')
  assert.equal(health.telemetry.lastErrorCode, null)
})

test('standby retry respects the server lease window with bounded jitter', () => {
  assert.equal(simulationStandbyRetryDelay(35_000, { random: () => 0 }), 30_000)
  assert.equal(simulationStandbyRetryDelay(35_000, { random: () => 1 }), 29_000)
  assert.equal(simulationStandbyRetryDelay(5_000, { random: () => 1 }), 4_500)
  assert.equal(simulationStandbyRetryDelay(undefined, { random: () => 0 }), 2_500)
})

test('a healthy standby lease must publish a heartbeat before returning online', () => {
  let health = updateSimulationBridgeLease(initialSimulationBridgeHealth(), false, { retryAfterMs: 20_000 })
  assert.equal(health.status, 'standby')
  health = updateSimulationBridgeLease(health, true)
  assert.equal(health.status, 'synchronizing')
  health = updateSimulationBridgeHealth(health, 'rpc', true)
  assert.equal(health.status, 'synchronizing')
  health = updateSimulationBridgeHealth(health, 'telemetry', true)
  assert.equal(health.status, 'online')
})
