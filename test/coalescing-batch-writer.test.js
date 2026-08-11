import test from 'node:test'
import assert from 'node:assert/strict'
import { CoalescingBatchWriter } from '../server/connectors/coalescing-batch-writer.js'
import { dispatchRuntimeEvent } from '../server/connectors/runtime-event-dispatch.js'

test('coalescing writer persists only the newest pending value per key', async () => {
  const batches = []
  const writer = new CoalescingBatchWriter({
    batchSize: 10,
    flushMs: 1000,
    maxPending: 10,
    keyFor: event => event.tagId,
    writeBatch: async batch => { batches.push(batch); return { written: batch.length } },
  })

  writer.enqueue({ tagId: 'temperature', value: 20 })
  writer.enqueue({ tagId: 'pressure', value: 3 })
  writer.enqueue({ tagId: 'temperature', value: 21 })
  await writer.flush()

  assert.equal(writer.stats.coalesced, 1)
  assert.equal(writer.stats.written, 2)
  assert.deepEqual(Object.fromEntries(batches[0].map(event => [event.tagId, event.value])), { pressure: 3, temperature: 21 })
})

test('a failed batch never replaces a newer value queued for the same key', async () => {
  let releaseFirstWrite
  let attempts = 0
  const batches = []
  const writer = new CoalescingBatchWriter({
    batchSize: 10,
    flushMs: 1000,
    maxPending: 10,
    keyFor: event => event.tagId,
    writeBatch: async batch => {
      attempts += 1
      batches.push(batch)
      if (attempts === 1) {
        await new Promise(resolve => { releaseFirstWrite = resolve })
        throw new Error('temporary failure')
      }
      return { written: batch.length }
    },
  })

  writer.enqueue({ tagId: 'temperature', value: 20 })
  const firstFlush = writer.flush()
  await Promise.resolve()
  writer.enqueue({ tagId: 'temperature', value: 22 })
  releaseFirstWrite()
  await firstFlush
  assert.equal(writer.pending.size, 1)

  await writer.flush({ force: true })
  assert.equal(batches[1][0].value, 22)
  assert.equal(writer.pending.size, 0)
})

test('coalescing writer bounds unique pending keys and preserves the newest entries', async () => {
  const batches = []
  const writer = new CoalescingBatchWriter({
    batchSize: 10,
    flushMs: 1000,
    maxPending: 2,
    keyFor: event => event.tagId,
    writeBatch: async batch => { batches.push(batch) },
  })

  writer.enqueue({ tagId: 'a', value: 1 })
  writer.enqueue({ tagId: 'b', value: 2 })
  writer.enqueue({ tagId: 'c', value: 3 })
  await writer.flush()

  assert.equal(writer.stats.dropped, 1)
  assert.deepEqual(batches[0].map(event => event.tagId), ['b', 'c'])
})

test('close drains pending values and rejects new events', async () => {
  const batches = []
  const writer = new CoalescingBatchWriter({
    batchSize: 2,
    flushMs: 1000,
    keyFor: event => event.tagId,
    writeBatch: async batch => { batches.push(batch) },
  })
  writer.start()
  writer.enqueue({ tagId: 'a', value: 1 })
  writer.enqueue({ tagId: 'b', value: 2 })
  writer.enqueue({ tagId: 'c', value: 3 })
  writer.enqueue({ tagId: 'd', value: 4 })
  writer.enqueue({ tagId: 'e', value: 5 })

  const stats = await writer.close()

  assert.equal(stats.pending, 0)
  assert.equal(stats.written, 5)
  assert.equal(writer.enqueue({ tagId: 'f', value: 6 }), false)
  assert.equal(batches.flat().length, 5)
})

test('runtime dispatch publishes before enqueueing persistence and health work', () => {
  const calls = []
  const event = { workspaceId: 'workspace-a', projectId: 'project-a', tagId: 'tag-a', receivedAt: '2026-08-09T00:00:00.000Z' }
  const accepted = dispatchRuntimeEvent({
    mode: 'published',
    event,
    environmentId: 'environment-a',
    hub: { publish: value => calls.push(['publish', value]) },
    snapshotWriter: { enqueue: value => calls.push(['snapshot', value]) },
    archiveWriter: { enqueue: value => calls.push(['archive', value]) },
    healthWriter: { enqueue: value => calls.push(['health', value]) },
  })

  assert.equal(accepted, true)
  assert.deepEqual(calls.map(([kind]) => kind), ['publish', 'snapshot', 'archive', 'health'])
  assert.deepEqual(calls[3][1], { environmentId: 'environment-a', receivedAt: event.receivedAt })
})

test('bootstrap telemetry does not publish or persist runtime events', () => {
  const calls = []
  const accepted = dispatchRuntimeEvent({
    mode: 'bootstrap',
    event: { projectId: 'project-a', tagId: 'tag-a' },
    environmentId: 'environment-a',
    hub: { publish: () => calls.push('publish') },
    snapshotWriter: { enqueue: () => calls.push('snapshot') },
    healthWriter: { enqueue: () => calls.push('health') },
  })

  assert.equal(accepted, false)
  assert.deepEqual(calls, [])
})
