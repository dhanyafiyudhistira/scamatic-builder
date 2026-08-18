import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntimeHistoryArchiveQueue } from '../shared/runtime-history-archive-queue.js'

test('runtime history archive queue acknowledges batches without losing newer entries', () => {
  const queue = createRuntimeHistoryArchiveQueue({ maxPending: 100 })
  queue.enqueue([{ tag: 'level', value: 10, timestamp: 1 }])
  const batch = queue.take()
  queue.enqueue([{ tag: 'level', value: 20, timestamp: 2 }])
  assert.equal(queue.acknowledge(batch.id), true)
  assert.deepEqual(queue.take().entries, [{ tag: 'level', value: 20, timestamp: 2 }])
})

test('runtime history archive queue retains a failed batch and bounds pending memory', () => {
  const queue = createRuntimeHistoryArchiveQueue({ maxPending: 100 })
  queue.enqueue(Array.from({ length: 100 }, (_, index) => ({ tag: 'level', value: index, timestamp: index + 1 })))
  const batch = queue.take(10)
  queue.enqueue(Array.from({ length: 20 }, (_, index) => ({ tag: 'level', value: index, timestamp: index + 101 })))
  assert.equal(queue.stats().pending, 100)
  assert.equal(queue.stats().dropped, 20)
  assert.equal(queue.retry(batch.id), true)
  assert.deepEqual(queue.take(10).entries, batch.entries)
})
