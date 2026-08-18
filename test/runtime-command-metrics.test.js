import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createRuntimeCommandMetricsRecorder,
  runtimeCommandMetricsCsv,
  runtimeCommandMetricsStorageKey,
  runtimeCommandMetricsSummary,
} from '../shared/runtime-command-metrics.js'

test('runtime command metrics calculate nearest-rank percentiles from the complete sample set', () => {
  const samples = Array.from({ length: 300 }, (_, index) => ({
    requestId: `request-${index + 1}`,
    observedAt: new Date(1_700_000_000_000 + index).toISOString(),
    status: 'acknowledged',
    mode: 'simulation',
    apiAuthorizationMs: 100 + index,
    workerQueueMs: 50,
    serverTotalMs: 200 + index,
  })).reverse()
  const summary = runtimeCommandMetricsSummary(samples)

  assert.equal(summary.count, 300)
  assert.equal(summary.metrics.apiAuthorizationMs.p50, 249)
  assert.equal(summary.metrics.apiAuthorizationMs.p95, 384)
  assert.equal(summary.metrics.serverTotalMs.p50, 349)
  assert.equal(summary.metrics.serverTotalMs.p95, 484)
  assert.equal(summary.acknowledgedRate, 100)
})

test('runtime command recorder tracks only locally started commands and deduplicates terminal updates', () => {
  let now = 1_000
  const recorder = createRuntimeCommandMetricsRecorder({ storage: null, now: () => now })
  assert.equal(recorder.record({ requestId: 'restored', status: 'acknowledged', timing: { serverTotalMs: 500 } }), false)
  assert.equal(recorder.start('request-1'), true)
  now = 1_275
  assert.equal(recorder.record({ requestId: 'request-1', status: 'acknowledged', timing: { mode: 'simulation', apiAuthorizationMs: 179, workerQueueMs: 63, serverTotalMs: 275, terminalPersistMs: 18, terminalAuditMs: 16, serverResponseReadyMs: 309 } }), true)
  assert.equal(recorder.record({ requestId: 'request-1', status: 'acknowledged', timing: { mode: 'simulation', gatewayRpcMs: 20 } }), true)

  const summary = recorder.summary()
  assert.equal(summary.count, 1)
  assert.equal(summary.metrics.clientEndToEndMs.p50, 275)
  assert.equal(summary.metrics.serverTotalMs.p95, 275)
  assert.equal(summary.metrics.terminalPersistMs.p50, 18)
  assert.equal(summary.metrics.serverResponseReadyMs.p50, 309)
  assert.equal(recorder.samples()[0].gatewayRpcMs, 20)
  recorder.start('cancelled-request')
  assert.equal(recorder.abandon('cancelled-request'), true)
  assert.equal(recorder.summary().inFlight, 0)
})

test('runtime command recorder bounds samples, reports unverified rate, and stores no payload fields', () => {
  const recorder = createRuntimeCommandMetricsRecorder({ storage: null, maxSamples: 10 })
  for (let index = 0; index < 12; index += 1) {
    recorder.start(`request-${index}`)
    recorder.record({
      requestId: `request-${index}`,
      status: index === 11 ? 'timeout' : 'acknowledged',
      correlationId: `secret-correlation-${index}`,
      payload: { value: 'must-not-be-recorded' },
      timing: { serverTotalMs: 200 + index },
    })
  }

  const samples = recorder.samples()
  assert.equal(samples.length, 10)
  assert.equal(samples[0].requestId, 'request-2')
  assert.equal(recorder.summary().unverifiedRate, 10)
  assert.equal('payload' in samples.at(-1), false)
  assert.equal('correlationId' in samples.at(-1), false)
})

test('runtime command recorder defers one coalesced session write and reloads it safely', () => {
  const storage = memoryStorage()
  const timers = fakeTimers()
  const storageKey = runtimeCommandMetricsStorageKey('project-a', 'version-a')
  const recorder = createRuntimeCommandMetricsRecorder({ storage, storageKey, persistDelayMs: 100, ...timers.options })
  recorder.start('request-1', { startedAt: 100 })
  recorder.record({ requestId: 'request-1', status: 'failed', timing: { serverTotalMs: 300 } }, { recordedAt: 450 })
  recorder.start('request-2', { startedAt: 500 })
  recorder.record({ requestId: 'request-2', status: 'unknown' }, { recordedAt: 800 })

  assert.equal(storage.writes, 0)
  assert.equal(timers.size(), 1)
  timers.run()
  assert.equal(storage.writes, 1)

  const restored = createRuntimeCommandMetricsRecorder({ storage, storageKey })
  assert.equal(restored.summary().count, 2)
  assert.equal(restored.summary().unverified, 1)
  assert.equal(restored.summary().maxInFlight, 1)
})

test('runtime command metrics export a spreadsheet-safe bounded CSV', () => {
  const csv = runtimeCommandMetricsCsv([{
    requestId: 'request-1',
    observedAt: '2026-08-13T00:00:00.000Z',
    status: 'acknowledged',
    mode: 'simulation',
    apiAuthorizationMs: 179,
    serverTotalMs: 275,
    terminalPersistMs: 18,
    serverResponseReadyMs: 309,
  }])
  assert.match(csv, /^requestId,observedAt,status,mode,/)
  assert.match(csv, /request-1,2026-08-13T00:00:00.000Z,acknowledged,simulation,179/)
  assert.match(csv, /terminalPersistMs/)
  assert.match(csv, /serverResponseReadyMs/)
})

function memoryStorage() {
  const values = new Map()
  return {
    writes: 0,
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { this.writes += 1; values.set(key, value) },
    removeItem(key) { values.delete(key) },
  }
}

function fakeTimers() {
  const callbacks = new Set()
  return {
    options: {
      setTimer(callback) { callbacks.add(callback); return { callback, unref() {} } },
      clearTimer(handle) { callbacks.delete(handle?.callback) },
    },
    size: () => callbacks.size,
    run() {
      for (const callback of callbacks) callback()
      callbacks.clear()
    },
  }
}
