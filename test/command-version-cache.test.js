import assert from 'node:assert/strict'
import test from 'node:test'
import { createCommandVersionCache } from '../server/connectors/command-version-cache.js'

test('published command version cache batches misses and serves repeated commands without another read', async () => {
  const cache = createCommandVersionCache({ maxEntries: 4, ttlMs: 60_000, now: () => 100 })
  const loads = []
  const loadMany = async ids => {
    loads.push(ids)
    return ids.map(id => ({ _id: id, schema: { id } }))
  }

  const first = await cache.load(['version-a', 'version-b', 'version-a'], loadMany)
  const second = await cache.load(['version-b', 'version-a'], loadMany)

  assert.deepEqual(loads, [['version-a', 'version-b']])
  assert.equal(first.get('version-a').schema.id, 'version-a')
  assert.equal(second.get('version-b').schema.id, 'version-b')
  assert.deepEqual(cache.snapshot(), {
    entries: 2, capacity: 4, ttlMs: 60_000, hits: 2, misses: 2, batchLoads: 1, evictions: 0,
  })
})

test('published command version cache expires, bounds LRU entries, and does not cache missing versions', async () => {
  let timestamp = 0
  const cache = createCommandVersionCache({ maxEntries: 2, ttlMs: 1_000, now: () => timestamp })
  let loads = 0
  const loadMany = async ids => {
    loads += 1
    return ids.filter(id => id !== 'missing').map(id => ({ _id: id }))
  }

  await cache.load(['a', 'missing'], loadMany)
  await cache.load(['b'], loadMany)
  await cache.load(['a'], loadMany)
  await cache.load(['c'], loadMany)
  assert.equal(cache.snapshot().evictions, 1)
  await cache.load(['missing'], loadMany)
  timestamp = 1_001
  await cache.load(['a'], loadMany)

  assert.equal(loads, 5)
  assert.equal(cache.snapshot().entries <= 2, true)
})

test('published command version cache preserves loader errors and retains no failed entry', async () => {
  const cache = createCommandVersionCache()
  await assert.rejects(cache.load(['version-a'], async () => { throw new Error('database unavailable') }), /database unavailable/)
  assert.equal(cache.snapshot().entries, 0)
  assert.equal(cache.snapshot().batchLoads, 1)
})
