import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntimeTelemetryFrame } from '../shared/runtime-telemetry-frame.js'

test('runtime telemetry frame combines batches into one scheduled render', () => {
  const scheduled = []
  const delivered = []
  const frame = createRuntimeTelemetryFrame({
    onFlush: events => delivered.push(events),
    schedule: callback => { scheduled.push(callback); return scheduled.length },
    cancel: () => {},
  })

  frame.enqueue([{ tagId: 'flow', value: 10 }])
  frame.enqueue([{ tagId: 'level', value: 20 }])

  assert.equal(scheduled.length, 1)
  assert.deepEqual(delivered, [])
  scheduled[0]()
  assert.deepEqual(delivered, [[
    { tagId: 'flow', value: 10 },
    { tagId: 'level', value: 20 },
  ]])
})

test('runtime telemetry frame can flush or discard a pending frame', () => {
  const delivered = []
  const cancelled = []
  const callbacks = []
  const frame = createRuntimeTelemetryFrame({
    onFlush: events => delivered.push(events),
    schedule: callback => { callbacks.push(callback); return callbacks.length },
    cancel: handle => cancelled.push(handle),
  })

  frame.enqueue([{ tagId: 'flow', value: 1 }])
  frame.flush()
  assert.deepEqual(cancelled, [1])
  assert.deepEqual(delivered, [[{ tagId: 'flow', value: 1 }]])

  frame.enqueue([{ tagId: 'flow', value: 2 }])
  frame.clear()
  assert.deepEqual(cancelled, [1, 2])
  assert.equal(delivered.length, 1)
})
