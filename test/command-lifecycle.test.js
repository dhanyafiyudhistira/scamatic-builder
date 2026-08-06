import test from 'node:test'
import assert from 'node:assert/strict'
import {
  commandCompletionBudgetMs,
  commandResultRetentionMs,
  commandStatusPresentation,
  isPendingCommandStatus,
  isTerminalCommandStatus,
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
