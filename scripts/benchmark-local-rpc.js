import { performance } from 'node:perf_hooks'
import { loadCommandStatusReads } from '../api/_lib/command-read-context.js'
import { createCommandVersionCache } from '../server/connectors/command-version-cache.js'

const ITERATIONS = positiveInteger(process.env.RPC_BENCH_ITERATIONS, 50)
const DATABASE_DELAY_MS = positiveInteger(process.env.RPC_BENCH_DATABASE_DELAY_MS, 5)
const RECONCILIATION_CONNECTORS = positiveInteger(process.env.RPC_BENCH_CONNECTORS, 10)

const sequentialPrincipalStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  await fakeRead({ id: 'auth-session' })
  await Promise.all([
    fakeRead({ id: 'user' }),
    fakeRead({ id: 'workspace-membership' }),
  ])
}
const sequentialPrincipalMs = performance.now() - sequentialPrincipalStarted

const joinedPrincipalStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  await fakeRead({ id: 'principal-context' })
}
const joinedPrincipalMs = performance.now() - joinedPrincipalStarted

const sequentialAdmissionStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  await Promise.all([
    fakeRead({ id: 'project' }),
    fakeRead({ id: 'runtime-session' }),
    fakeRead(null),
  ])
  await fakeRead({ role: 'OPERATOR' })
}
const sequentialAdmissionMs = performance.now() - sequentialAdmissionStarted

const overlappedAdmissionStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  await Promise.all([
    fakeRead({ id: 'project' }),
    fakeRead({ id: 'runtime-session' }),
    fakeRead(null),
    fakeRead({ role: 'OPERATOR' }),
  ])
}
const overlappedAdmissionMs = performance.now() - overlappedAdmissionStarted

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

let previousAuthorizationWrites = 0
const previousAuthorizationStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  previousAuthorizationWrites += 3
  await fakeRead(true) // requested command insert
  await fakeRead(true) // authorization audit insert
  await fakeRead(true) // requested -> authorized update
}
const previousAuthorizationMs = performance.now() - previousAuthorizationStarted

let atomicAuthorizationWrites = 0
const atomicAuthorizationStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  atomicAuthorizationWrites += 2
  await fakeRead(true) // authorization audit insert
  await fakeRead(true) // authorized command insert in the same transaction
}
const atomicAuthorizationMs = performance.now() - atomicAuthorizationStarted

let previousSimulationWrites = 0
const previousSimulationStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  previousSimulationWrites += 6
  await fakeRead(true) // requested command insert
  await fakeRead(true) // authorization state update
  await fakeRead(true) // authorization audit insert
  await fakeRead(true) // dispatch state update
  await fakeRead(true) // terminal state update
  await fakeRead(true) // terminal audit insert
}
const previousSimulationMs = performance.now() - previousSimulationStarted

let atomicSimulationWrites = 0
const atomicSimulationStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  atomicSimulationWrites += 2
  await fakeRead(true) // authorized + terminal audit insertMany
  await fakeRead(true) // completed command insert in the same transaction
}
const atomicSimulationMs = performance.now() - atomicSimulationStarted

let previousReconciliationReads = 1 // global active-session scan
const previousReconciliationStarted = performance.now()
await fakeRead(true)
for (let index = 0; index < RECONCILIATION_CONNECTORS; index += 1) {
  previousReconciliationReads += 3
  await fakeRead(true) // environment
  await fakeRead(true) // project
  await fakeRead(true) // published version
}
const previousReconciliationMs = performance.now() - previousReconciliationStarted

let batchedReconciliationReads = 3
const batchedReconciliationStarted = performance.now()
await fakeRead(true) // environments
await fakeRead(true) // projects
await fakeRead(true) // published versions
const batchedReconciliationMs = performance.now() - batchedReconciliationStarted

let previousRateLimitWrites = 0
const previousRateLimitStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  previousRateLimitWrites += 1
  await fakeRead(true)
}
const previousRateLimitMs = performance.now() - previousRateLimitStarted

const permitLeaseSize = 12
let leasedRateLimitWrites = 0
const leasedRateLimitStarted = performance.now()
for (let index = 0; index < ITERATIONS; index += 1) {
  if (index % permitLeaseSize !== 0) continue
  leasedRateLimitWrites += 1
  await fakeRead(true)
}
const leasedRateLimitMs = performance.now() - leasedRateLimitStarted

console.log(JSON.stringify({
  scenario: 'controlled-local-rpc-database-round-trips',
  iterations: ITERATIONS,
  simulatedDatabaseDelayMs: DATABASE_DELAY_MS,
  principalAuthentication: {
    sequentialMs: rounded(sequentialPrincipalMs),
    joinedMs: rounded(joinedPrincipalMs),
    speedup: rounded(sequentialPrincipalMs / joinedPrincipalMs),
    databaseCommands: { sequential: ITERATIONS * 3, joined: ITERATIONS },
  },
  operatorAdmission: {
    sequentialMs: rounded(sequentialAdmissionMs),
    overlappedMs: rounded(overlappedAdmissionMs),
    speedup: rounded(sequentialAdmissionMs / overlappedAdmissionMs),
    databaseReads: { sequential: ITERATIONS * 4, overlapped: ITERATIONS * 4 },
  },
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
  workerAuthorizationWrites: {
    previousMs: rounded(previousAuthorizationMs),
    atomicMs: rounded(atomicAuthorizationMs),
    speedup: rounded(previousAuthorizationMs / atomicAuthorizationMs),
    databaseWrites: { previous: previousAuthorizationWrites, atomic: atomicAuthorizationWrites },
  },
  simulationCompletionWrites: {
    previousMs: rounded(previousSimulationMs),
    atomicMs: rounded(atomicSimulationMs),
    speedup: rounded(previousSimulationMs / atomicSimulationMs),
    databaseWrites: { previous: previousSimulationWrites, atomic: atomicSimulationWrites },
  },
  publishedWorkerReconciliation: {
    connectors: RECONCILIATION_CONNECTORS,
    previousMs: rounded(previousReconciliationMs),
    batchedMs: rounded(batchedReconciliationMs),
    speedup: rounded(previousReconciliationMs / batchedReconciliationMs),
    databaseReads: { previous: previousReconciliationReads, batched: batchedReconciliationReads },
  },
  commandRateLimitWrites: {
    permitLeaseSize,
    previousMs: rounded(previousRateLimitMs),
    leasedMs: rounded(leasedRateLimitMs),
    speedup: rounded(previousRateLimitMs / leasedRateLimitMs),
    databaseWrites: { previous: previousRateLimitWrites, leased: leasedRateLimitWrites },
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
