import { performance } from 'node:perf_hooks'
import { loadCommandStatusReads } from '../api/_lib/command-read-context.js'
import { createCommandVersionCache } from '../server/connectors/command-version-cache.js'

const ITERATIONS = positiveInteger(process.env.RPC_BENCH_ITERATIONS, 50)
const DATABASE_DELAY_MS = positiveInteger(process.env.RPC_BENCH_DATABASE_DELAY_MS, 5)

const sequentialStatusStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  await fakeRead({ id: 'project' })
  await fakeRead({ id: 'session' })
}
const sequentialStatusMs = performance.now() - sequentialStatusStarted

const parallelStatusStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  await loadCommandStatusReads({
    loadProject: () => fakeRead({ id: 'project' }),
    loadRuntimeSession: () => fakeRead({ id: 'session' }),
  })
}
const parallelStatusMs = performance.now() - parallelStatusStarted

let legacyVersionReads = 0
const legacyVersionStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  legacyVersionReads += 1
  await fakeRead([{ _id: 'published-version' }])
}
const legacyVersionMs = performance.now() - legacyVersionStarted

let cachedVersionReads = 0
const cache = createCommandVersionCache({ maxEntries: 8, ttlMs: 60_000 })
const cachedVersionStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  const versions = await cache.load(['published-version'], async ids => {
    cachedVersionReads += 1
    return fakeRead(ids.map(_id => ({ _id })))
  })
  if (!versions.has('published-version')) throw new Error('Cached version benchmark lost the published schema.')
}
const cachedVersionMs = performance.now() - cachedVersionStarted

console.log(JSON.stringify({
  scenario: 'controlled-local-rpc-database-round-trips',
  iterations: ITERATIONS,
  simulatedDatabaseDelayMs: DATABASE_DELAY_MS,
  statusReads: {
    sequentialMs: rounded(sequentialStatusMs),
    parallelMs: rounded(parallelStatusMs),
    speedup: rounded(sequentialStatusMs / parallelStatusMs),
    databaseReads: { sequential: ITERATIONS * 2, parallel: ITERATIONS * 2 },
  },
  publishedVersionReads: {
    uncachedMs: rounded(legacyVersionMs),
    cachedMs: rounded(cachedVersionMs),
    speedup: rounded(legacyVersionMs / cachedVersionMs),
    databaseReads: { uncached: legacyVersionReads, cached: cachedVersionReads },
  },
  note: 'Controlled latency benchmark; it measures avoided/overlapped local database waits, not ThingsBoard network latency.',
}, null, 2))

function fakeRead(value) {
  return new Promise(resolve => setTimeout(() => resolve(value), DATABASE_DELAY_MS))
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function rounded(value) {
  return Math.round(value * 100) / 100
}
