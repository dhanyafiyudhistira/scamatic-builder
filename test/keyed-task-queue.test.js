import test from 'node:test'
import assert from 'node:assert/strict'
import { createKeyedTaskQueue } from '../server/connectors/keyed-task-queue.js'

test('keyed task queue serializes one connector while keeping different connectors parallel', async () => {
  const queue = createKeyedTaskQueue()
  const firstA = deferred()
  const firstB = deferred()
  const started = []

  queue.enqueue('connector-a', async () => { started.push('a1'); await firstA.promise }, { id: 'a1' })
  queue.enqueue('connector-a', async () => { started.push('a2') }, { id: 'a2' })
  queue.enqueue('connector-b', async () => { started.push('b1'); await firstB.promise }, { id: 'b1' })
  await turn()

  assert.deepEqual(started, ['a1', 'b1'])
  assert.deepEqual(queue.snapshot(), {
    accepting: true, capacity: 200, active: 2, queued: 1, pending: 3, lanes: 2, completed: 0, failed: 0, canceled: 0,
  })

  firstA.resolve()
  await turn()
  assert.deepEqual(started, ['a1', 'b1', 'a2'])
  firstB.resolve()
  await queue.close()
  assert.equal(queue.snapshot().completed, 3)
})

test('keyed task queue deduplicates ids and leaves canceled work unexecuted during shutdown', async () => {
  const queue = createKeyedTaskQueue()
  const active = deferred()
  const ran = []
  const canceled = []

  assert.equal(queue.enqueue('connector-a', async () => { ran.push('active'); await active.promise }, { id: 'command-1' }), true)
  assert.equal(queue.enqueue('connector-a', async () => { ran.push('queued') }, { id: 'command-2', onCancel: event => canceled.push(event.id) }), true)
  assert.equal(queue.enqueue('connector-a', async () => {}, { id: 'command-2' }), false)
  await turn()

  const closing = queue.close({ timeoutMs: 1_000 })
  assert.deepEqual(queue.pendingIds(), ['command-1'])
  assert.deepEqual(canceled, ['command-2'])
  assert.equal(queue.enqueue('connector-b', async () => {}), false)
  active.resolve()

  const result = await closing
  assert.equal(result.timedOut, false)
  assert.deepEqual(ran, ['active'])
  assert.equal(result.canceled, 1)
})

test('keyed task queue reports failures without blocking the next command in a lane', async () => {
  const errors = []
  const ran = []
  const queue = createKeyedTaskQueue({ onError: (error, context) => errors.push([error.message, context.id]) })

  queue.enqueue('connector-a', async () => { throw new Error('dispatch failed') }, { id: 'command-1' })
  queue.enqueue('connector-a', async () => { ran.push('command-2') }, { id: 'command-2' })
  const result = await queue.close({ cancelPending: false })

  assert.deepEqual(errors, [['dispatch failed', 'command-1']])
  assert.deepEqual(ran, ['command-2'])
  assert.equal(result.failed, 1)
  assert.equal(result.completed, 2)
})

test('keyed task queue bounds shutdown waiting without starting canceled work', async () => {
  const queue = createKeyedTaskQueue()
  const active = deferred()
  queue.enqueue('connector-a', () => active.promise, { id: 'command-1' })
  await turn()

  const result = await queue.close({ timeoutMs: 5 })
  assert.equal(result.timedOut, true)
  assert.equal(result.active, 1)
  active.resolve()
  await turn()
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function turn() {
  return new Promise(resolve => setImmediate(resolve))
}
