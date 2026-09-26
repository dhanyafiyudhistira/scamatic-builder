import test from 'node:test'
import assert from 'node:assert/strict'
import { createControlCommandIntentQueue } from '../shared/control-command-intent.js'

test('rapid toggle presses retain only the latest desired state', () => {
  const queue = createControlCommandIntentQueue({ currentValue: false })
  assert.deepEqual(queue.press(false), {
    kind: 'dispatch',
    value: true,
    state: { inFlight: true, queued: false, desiredValue: true },
  })
  assert.equal(queue.press(false).value, false)
  assert.equal(queue.press(false).value, true)

  const settled = queue.settle({ ok: true, status: 'acknowledged', value: true })
  assert.equal(settled.kind, 'idle')
  assert.deepEqual(settled.state, { inFlight: false, queued: false, desiredValue: true })
})

test('a changed toggle intent is dispatched only after the prior acknowledgment', () => {
  const queue = createControlCommandIntentQueue({ currentValue: false })
  queue.press(false)
  queue.press(false)

  const next = queue.settle({ ok: true, status: 'acknowledged', value: true })
  assert.equal(next.kind, 'dispatch')
  assert.equal(next.value, false)
  assert.deepEqual(next.state, { inFlight: true, queued: false, desiredValue: false })
})

test('pulse input is bounded to one queued edge and failures discard it', () => {
  const queue = createControlCommandIntentQueue({ action: 'pulse' })
  assert.equal(queue.press(false).kind, 'dispatch')
  assert.equal(queue.press(false).kind, 'queued')
  assert.equal(queue.press(false).kind, 'queued')
  assert.equal(queue.settle({ ok: false, status: 'failed' }).kind, 'idle')
  assert.deepEqual(queue.snapshot(), { inFlight: false, queued: false, desiredValue: false })
})

test('pulse input drains one queued edge after acknowledgment', () => {
  const queue = createControlCommandIntentQueue({ action: 'pulse' })
  queue.press(false)
  queue.press(false)
  const next = queue.settle({ ok: true, status: 'acknowledged', value: true })
  assert.equal(next.kind, 'dispatch')
  assert.equal(next.value, undefined)
})

test('repeated fixed-value input is coalesced while in flight', () => {
  const queue = createControlCommandIntentQueue({ action: 'set-value', payload: 7 })
  assert.deepEqual(queue.press(0).kind, 'dispatch')
  assert.equal(queue.press(0).kind, 'coalesced')
  assert.equal(queue.settle({ ok: true, status: 'acknowledged', value: 7 }).kind, 'idle')
})

test('toggle queue carries the latest operator intent timestamp into its trailing command', () => {
  const queue = createControlCommandIntentQueue({ currentValue: false })
  const first = queue.press(false, { intentAt: 100 })
  queue.press(false, { intentAt: 150 })
  queue.press(false, { intentAt: 225 })

  assert.equal(first.intentAt, 100)
  const next = queue.settle({ ok: true, status: 'acknowledged', value: true })
  assert.equal(next.kind, 'idle')

  queue.press(true, { intentAt: 300 })
  queue.press(true, { intentAt: 375 })
  const trailing = queue.settle({ ok: true, status: 'acknowledged', value: false })
  assert.equal(trailing.kind, 'dispatch')
  assert.equal(trailing.intentAt, 375)
})

test('pulse queue measures its one accepted trailing edge from the first queued press', () => {
  const queue = createControlCommandIntentQueue({ action: 'pulse' })
  queue.press(false, { intentAt: 100 })
  queue.press(false, { intentAt: 175 })
  queue.press(false, { intentAt: 250 })

  const trailing = queue.settle({ ok: true, status: 'acknowledged', value: true })
  assert.equal(trailing.kind, 'dispatch')
  assert.equal(trailing.intentAt, 175)
})
