import test from 'node:test'
import assert from 'node:assert/strict'
import { createSimulationTelemetryQueue } from '../shared/simulation-telemetry-queue.js'

test('simulation telemetry queue coalesces adjacent steady-state changes', () => {
  const queue = createSimulationTelemetryQueue()
  queue.enqueue({ valve: true, level: 10 })
  const second = queue.enqueue({ level: 20, motor: true })

  assert.equal(second.coalesced, true)
  assert.deepEqual(queue.take(), {
    id: 1,
    kind: 'steady',
    values: { valve: true, level: 20, motor: true },
  })
})

test('simulation telemetry queue preserves pulse edges and recipe order', () => {
  const queue = createSimulationTelemetryQueue()
  queue.enqueue({ reset: true }, { preserveOrder: true })
  queue.enqueue({ reset: false }, { preserveOrder: true })

  const active = queue.take()
  assert.deepEqual(active.values, { reset: true })
  assert.equal(queue.acknowledge(active.id), true)
  const inactive = queue.take()
  assert.deepEqual(inactive.values, { reset: false })
})

test('simulation telemetry queue retains a failed job ahead of newer work', () => {
  const queue = createSimulationTelemetryQueue()
  queue.enqueue({ valve: true })
  const failed = queue.take()
  queue.enqueue({ valve: false })

  assert.equal(queue.retry(failed.id), true)
  assert.deepEqual(queue.take().values, { valve: true })
  assert.equal(queue.acknowledge(failed.id), true)
  assert.deepEqual(queue.take().values, { valve: false })
})

test('simulation telemetry queue never merges new state into an in-flight job', () => {
  const queue = createSimulationTelemetryQueue()
  queue.enqueue({ level: 10 })
  const inFlight = queue.take()
  const queued = queue.enqueue({ level: 20 })

  assert.equal(queued.coalesced, false)
  assert.equal(queue.acknowledge(inFlight.id), true)
  assert.deepEqual(queue.take().values, { level: 20 })
})

test('simulation telemetry queue bounds ordered backlog and coalesces heartbeats', () => {
  const queue = createSimulationTelemetryQueue({ maxPending: 8 })
  for (let index = 0; index < 7; index += 1) {
    assert.equal(queue.enqueue({ pulse: index }, { preserveOrder: true }).accepted, true)
  }
  assert.equal(queue.enqueueHeartbeat().accepted, true)
  assert.equal(queue.enqueueHeartbeat().coalesced, true)
  assert.deepEqual(queue.enqueue({ pulse: 8 }, { preserveOrder: true }), { accepted: false, reason: 'full' })
})
