import assert from 'node:assert/strict'
import test from 'node:test'
import { createRpcPerformanceTracker } from '../server/connectors/rpc-performance.js'

test('RPC performance tracker exports bounded aggregate timing without identifiers or payloads', () => {
  let timestamp = 10_000
  const tracker = createRpcPerformanceTracker({ maxSamples: 10, now: () => timestamp })
  for (let index = 1; index <= 12; index += 1) {
    timestamp += 1
    assert.equal(tracker.record(command(index, index === 12 ? 'timeout' : 'acknowledged')), true)
  }

  const snapshot = tracker.snapshot()
  assert.equal(snapshot.samples, 10)
  assert.equal(snapshot.observed, 12)
  assert.deepEqual(snapshot.statuses, { acknowledged: 9, rejected: 0, timeout: 1, failed: 0 })
  assert.deepEqual(snapshot.timingMs.serverTotalMs, { count: 10, min: 3, p50: 7, p95: 12, p99: 12, max: 12 })
  assert.equal(JSON.stringify(snapshot).includes('request-secret'), false)
  assert.equal(JSON.stringify(snapshot).includes('payload-secret'), false)
})

test('RPC performance tracker ignores pending and malformed events', () => {
  const tracker = createRpcPerformanceTracker()
  assert.equal(tracker.record({ status: 'dispatched', requestId: 'pending' }), false)
  assert.equal(tracker.record({ status: 'acknowledged' }), false)
  assert.equal(tracker.snapshot().samples, 0)
})

function command(duration, status) {
  const start = new Date('2026-01-01T00:00:00.000Z').getTime()
  return {
    status,
    requestId: 'request-secret',
    payloadSummary: { value: 'payload-secret' },
    executionMode: 'worker',
    requestReceivedAt: new Date(start),
    authorizedAt: new Date(start + 1),
    dispatchedAt: new Date(start + 2),
    upstreamStartedAt: new Date(start + 2),
    gatewayAcceptedAt: new Date(start + Math.max(2, duration - 1)),
    upstreamCompletedAt: new Date(start + duration),
    completedAt: new Date(start + duration),
  }
}
