import test from 'node:test'
import assert from 'node:assert/strict'
import {
  commandCompletionBudgetMs,
  commandResultCanReplace,
  commandResultRetentionMs,
  commandStatusCanReplace,
  commandStatusRank,
  commandStatusPresentation,
  commandTimingProjection,
  isPendingCommandStatus,
  isTerminalCommandStatus,
  runtimeCommandProjection,
} from '../shared/command-lifecycle.js'

test('command lifecycle separates gateway progress from terminal device outcomes', () => {
  assert.equal(isPendingCommandStatus('accepted_by_gateway'), true)
  assert.equal(isTerminalCommandStatus('accepted_by_gateway'), false)
  assert.equal(commandStatusPresentation('accepted_by_gateway').label, 'AWAITING FEEDBACK')
  assert.equal(isTerminalCommandStatus('acknowledged'), true)
  assert.equal(commandStatusPresentation('acknowledged').tone, 'success')
})

test('terminal command outcomes remain visible long enough for an operator', () => {
  assert.equal(commandResultRetentionMs('acknowledged'), 12_000)
  assert.equal(commandResultRetentionMs('timeout'), 15_000)
  assert.equal(commandStatusPresentation('timeout').label, 'UNVERIFIED / TIMEOUT')
  assert.equal(commandStatusPresentation('timeout').tone, 'warning')
  assert.equal(commandStatusPresentation('rejected').label, 'REJECTED')
  assert.equal(commandStatusPresentation('failed').label, 'FAILED')
})

test('command completion uses one bounded end-to-end timeout budget', () => {
  assert.equal(commandCompletionBudgetMs(8000), 13_000)
  assert.equal(commandCompletionBudgetMs(30_000), 35_000)
  assert.equal(commandCompletionBudgetMs(90_000), 35_000)
  assert.equal(commandCompletionBudgetMs('invalid'), 10_000)
})

test('pushed command progress is monotonic and cannot regress a terminal result', () => {
  assert.equal(commandStatusRank('authorized') < commandStatusRank('dispatched'), true)
  assert.equal(commandStatusCanReplace('authorized', 'acknowledged'), true)
  assert.equal(commandStatusCanReplace('acknowledged', 'authorized'), false)
  assert.equal(commandStatusCanReplace('acknowledged', 'failed'), false)
  assert.equal(commandStatusCanReplace('acknowledged', 'acknowledged'), true)
})

test('an early WebSocket terminal result wins over a later HTTP pending response', () => {
  const terminal = { requestId: 'request-1', status: 'acknowledged', createdAt: '2026-08-09T10:00:00.000Z' }
  const pending = { requestId: 'request-1', status: 'authorized', createdAt: '2026-08-09T10:00:00.000Z' }
  assert.equal(commandResultCanReplace(terminal, pending), false)
  assert.equal(commandResultCanReplace(pending, terminal), true)

  const newerRequest = { requestId: 'request-2', status: 'requested', createdAt: '2026-08-09T10:00:01.000Z' }
  assert.equal(commandResultCanReplace(terminal, newerRequest), true)
  assert.equal(commandResultCanReplace(newerRequest, terminal), false)
})

test('runtime command projection exposes only the operator-safe lifecycle fields', () => {
  const result = runtimeCommandProjection({
    requestId: 'request-1',
    status: 'acknowledged',
    componentId: 'button-a',
    tagId: 'tag-a',
    actorId: 'user-secret',
    payloadSummary: { token: 'must-not-leak' },
    resultSummary: { message: 'Command acknowledged.', value: true },
    correlationId: 'correlation-1',
  })
  assert.equal(result.ok, true)
  assert.equal(result.value, true)
  assert.equal('actorId' in result, false)
  assert.equal('payloadSummary' in result, false)
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
})

test('RPC timing projection separates API, queue, gateway, and feedback phases', () => {
  const timing = commandTimingProjection({
    acknowledgmentMode: 'feedback-tag',
    requestReceivedAt: '2026-08-10T00:00:00.000Z',
    authorizedAt: '2026-08-10T00:00:00.320Z',
    dispatchedAt: '2026-08-10T00:00:00.445Z',
    upstreamStartedAt: '2026-08-10T00:00:00.480Z',
    gatewayAcceptedAt: '2026-08-10T00:00:00.610Z',
    upstreamCompletedAt: '2026-08-10T00:00:01.110Z',
    completedAt: '2026-08-10T00:00:01.160Z',
  })
  assert.deepEqual(timing, {
    mode: 'feedback-tag',
    apiAuthorizationMs: 320,
    workerQueueMs: 125,
    gatewayRpcMs: 130,
    feedbackWaitMs: 500,
    upstreamRoundTripMs: 630,
    terminalProcessingMs: 50,
    serverTotalMs: 1160,
  })
})

test('RPC timing omits negative cross-host durations instead of reporting misleading values', () => {
  const timing = commandTimingProjection({
    requestReceivedAt: '2026-08-10T00:00:01.000Z',
    authorizedAt: '2026-08-10T00:00:00.900Z',
    completedAt: '2026-08-10T00:00:02.000Z',
  })
  assert.deepEqual(timing, { serverTotalMs: 1000 })
})

test('mock command timing is labeled as simulation instead of a live RPC acknowledgment', () => {
  const timing = commandTimingProjection({
    executionMode: 'mock',
    requestReceivedAt: '2026-08-10T00:00:00.000Z',
    authorizedAt: '2026-08-10T00:00:00.200Z',
    dispatchedAt: '2026-08-10T00:00:00.240Z',
    completedAt: '2026-08-10T00:00:00.260Z',
  })
  assert.deepEqual(timing, {
    mode: 'simulation',
    apiAuthorizationMs: 200,
    workerQueueMs: 40,
    serverTotalMs: 260,
  })
})
