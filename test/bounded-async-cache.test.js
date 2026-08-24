import assert from 'node:assert/strict'
import test from 'node:test'
import { createBoundedAsyncCache } from '../api/_lib/bounded-async-cache.js'

test('bounded async cache coalesces concurrent loads and expires entries', async () => {
  let timestamp = 1
  let loads = 0
  const cache = createBoundedAsyncCache({ maxEntries: 2, ttlMs: 1_000, now: () => timestamp })
  const loader = async () => { loads += 1; return { version: loads } }

  const [first, concurrent] = await Promise.all([cache.get('version-1', loader), cache.get('version-1', loader)])
  assert.equal(loads, 1)
  assert.equal(first, concurrent)
  assert.equal((await cache.get('version-1', loader)).version, 1)

  timestamp = 1_002
  assert.equal((await cache.get('version-1', loader)).version, 2)
  assert.equal(loads, 2)
})

test('bounded async cache evicts the least recently used entry', async () => {
  const cache = createBoundedAsyncCache({ maxEntries: 2, ttlMs: 60_000, now: () => 1 })
  let loads = 0
  const load = value => async () => { loads += 1; return value }

  await cache.get('a', load('A'))
  await cache.get('b', load('B'))
  await cache.get('a', load('unused'))
  await cache.get('c', load('C'))
  assert.equal(cache.size(), 2)
  assert.equal(await cache.get('b', load('B2')), 'B2')
  assert.equal(loads, 4)
})

test('bounded async cache never retains missing or failed loads', async () => {
  const cache = createBoundedAsyncCache()
  assert.equal(await cache.get('missing', async () => null), null)
  assert.equal(cache.size(), 0)
  await assert.rejects(cache.get('failed', async () => { throw new Error('load failed') }), /load failed/)
  assert.equal(cache.size(), 0)
})
