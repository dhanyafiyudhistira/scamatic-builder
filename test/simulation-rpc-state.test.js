import test from 'node:test'
import assert from 'node:assert/strict'
import { SimulationResponderLease } from '../api/_lib/models.js'
import { acquireSimulationResponderLease, releaseSimulationResponderLease, simulationResponderKey, simulationResponderPolicy, simulationRpcLifecycleId, takeoverSimulationResponderLease } from '../api/_lib/simulation-rpc-state.js'

test('simulation RPC lifecycle IDs isolate projects, versions, and upstream request IDs', () => {
  const first = simulationRpcLifecycleId('project-a', 'version-a', '42')
  assert.equal(first, simulationRpcLifecycleId('project-a', 'version-a', '42'))
  assert.notEqual(first, simulationRpcLifecycleId('project-b', 'version-a', '42'))
  assert.notEqual(first, simulationRpcLifecycleId('project-a', 'version-b', '42'))
  assert.notEqual(first, simulationRpcLifecycleId('project-a', 'version-a', '43'))
})

test('simulation responder policy keeps the lease longer than one RPC long poll', () => {
  const previousLease = process.env.SIMULATION_RESPONDER_LEASE_MS
  const previousRetention = process.env.SIMULATION_RPC_RETENTION_MS
  try {
    delete process.env.SIMULATION_RESPONDER_LEASE_MS
    delete process.env.SIMULATION_RPC_RETENTION_MS
    assert.deepEqual(simulationResponderPolicy(), {
      leaseMs: 35_000,
      rpcRetentionMs: 24 * 60 * 60_000,
    })
    process.env.SIMULATION_RESPONDER_LEASE_MS = '1000'
    assert.equal(simulationResponderPolicy().leaseMs, 25_000)
  } finally {
    if (previousLease === undefined) delete process.env.SIMULATION_RESPONDER_LEASE_MS
    else process.env.SIMULATION_RESPONDER_LEASE_MS = previousLease
    if (previousRetention === undefined) delete process.env.SIMULATION_RPC_RETENTION_MS
    else process.env.SIMULATION_RPC_RETENTION_MS = previousRetention
  }
})

test('simulation responder keys identify the physical ThingsBoard target rather than a project', () => {
  const first = simulationResponderKey('https://tb.example.com', 'device-token-a')
  assert.equal(first, simulationResponderKey('https://tb.example.com', 'device-token-a'))
  assert.equal(first, simulationResponderKey('https://tb.example.com/', 'device-token-a'))
  assert.notEqual(first, simulationResponderKey('https://tb.example.com', 'device-token-b'))
  assert.notEqual(first, simulationResponderKey('https://other.example.com', 'device-token-a'))
})

test('a newer generation from the same browser tab can atomically replace its stale lease', async () => {
  const original = SimulationResponderLease.findOneAndUpdate
  let captured = null
  try {
    SimulationResponderLease.findOneAndUpdate = (filter, update) => ({
      lean: async () => {
        captured = { filter, update }
        return { expiresAt: update.$set.expiresAt }
      },
    })
    const lease = await acquireSimulationResponderLease({
      responderKey: simulationResponderKey('https://tb.example.com', 'device-token-a'),
      projectId: 'project-a',
      versionId: 'version-a',
      runtimeSessionId: 'runtime-session-id-0002',
      responderId: 'runtime-tab-identity-0001',
      responderGeneration: 2,
      now: new Date('2026-07-30T12:00:00.000Z'),
    })
    assert.equal(lease.active, true)
    assert.deepEqual(captured.filter.$or[2], {
      $and: [
        { responderId: 'runtime-tab-identity-0001' },
        {
          $or: [
            { responderGeneration: { $lt: 2 } },
            { responderGeneration: { $exists: false } },
          ],
        },
      ],
    })
    assert.deepEqual(captured.filter.$or[3], {
      responderId: { $exists: false },
      projectId: 'project-a',
      versionId: 'version-a',
    })
    assert.equal(captured.update.$set.runtimeSessionId, 'runtime-session-id-0002')
    assert.equal(captured.update.$set.responderGeneration, 2)
  } finally {
    SimulationResponderLease.findOneAndUpdate = original
  }
})

test('an explicit operator takeover replaces a stale responder without waiting for lease expiry', async () => {
  const original = SimulationResponderLease.findOneAndUpdate
  let captured = null
  try {
    SimulationResponderLease.findOneAndUpdate = (filter, update) => ({
      lean: async () => {
        captured = { filter, update }
        return { expiresAt: update.$set.expiresAt }
      },
    })
    const key = simulationResponderKey('https://tb.example.com', 'device-token-a')
    const lease = await takeoverSimulationResponderLease({
      responderKey: key,
      projectId: 'project-a',
      versionId: 'version-a',
      runtimeSessionId: 'runtime-session-id-0003',
      responderId: 'runtime-tab-identity-0003',
      responderGeneration: 1,
      now: new Date('2026-08-01T12:00:00.000Z'),
    })
    assert.equal(lease.active, true)
    assert.equal(lease.takenOver, true)
    assert.match(captured.filter._id, /^[a-f0-9]{64}$/)
    assert.equal(captured.update.$set.responderKey, key)
    assert.equal(captured.update.$set.runtimeSessionId, 'runtime-session-id-0003')
  } finally {
    SimulationResponderLease.findOneAndUpdate = original
  }
})

test('lease release is scoped to the current runtime session owner', async () => {
  const original = SimulationResponderLease.deleteOne
  let captured = null
  try {
    SimulationResponderLease.deleteOne = async filter => {
      captured = filter
      return { deletedCount: 1 }
    }
    const key = simulationResponderKey('https://tb.example.com', 'device-token-a')
    const result = await releaseSimulationResponderLease({ responderKey: key, runtimeSessionId: 'runtime-session-id-0003' })
    assert.equal(result.released, true)
    assert.match(captured._id, /^[a-f0-9]{64}$/)
    assert.equal(captured.runtimeSessionId, 'runtime-session-id-0003')
  } finally {
    SimulationResponderLease.deleteOne = original
  }
})
