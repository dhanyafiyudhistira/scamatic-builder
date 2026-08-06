import test from 'node:test'
import assert from 'node:assert/strict'
import {
  initialSimulationBridgeHealth,
  simulationCommandConnectionAvailable,
  updateSimulationBridgeHealth,
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
  assert.equal(simulationCommandConnectionAvailable('real', 'degraded'), false)
  assert.equal(simulationCommandConnectionAvailable('real', 'online'), true)
})
