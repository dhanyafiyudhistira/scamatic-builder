import test from 'node:test'
import assert from 'node:assert/strict'
import { commandAcknowledgment, commandAcknowledgmentTimeout } from '../shared/command-acknowledgment.js'

test('component feedback readback takes priority over connector-wide two-way RPC', () => {
  const acknowledgment = commandAcknowledgment({
    properties: {
      feedbackTagId: 'tb.valve_205',
      expectedFeedbackValue: true,
      ackTimeoutMs: 7500,
    },
  }, {
    rpcMode: 'two-way',
    commandTimeoutMs: 5000,
  }, false)

  assert.deepEqual(acknowledgment, {
    mode: 'feedback-tag',
    tagId: 'tb.valve_205',
    expectedValue: true,
    timeoutMs: 7500,
  })
})

test('two-way RPC remains available when a component has no feedback readback', () => {
  assert.deepEqual(commandAcknowledgment({ properties: {} }, {
    rpcMode: 'two-way',
    commandTimeoutMs: 4200,
  }, true), {
    mode: 'two-way',
    timeoutMs: 4200,
  })
})

test('Operation Shifter feedback acknowledges the resulting mode instead of the full recipe object', () => {
  assert.deepEqual(commandAcknowledgment({ type: 'operation-shifter', properties: { feedbackTagId: 'mode.actual', ackTimeoutMs: 8000 } }, {}, {
    mode: 'auto', sequence: [{ rpcMethod: 'setValveA', value: true }],
  }), {
    mode: 'feedback-tag',
    tagId: 'mode.actual',
    expectedValue: 'auto',
    timeoutMs: 8000,
  })
})

test('feedback-tag connectors reject commands without a component readback', () => {
  assert.equal(commandAcknowledgment({ properties: {} }, {
    rpcMode: 'feedback-tag',
    commandTimeoutMs: 5000,
  }, true), null)
})

test('an acknowledgment timeout is unverified and never marks liveness offline', () => {
  assert.deepEqual(commandAcknowledgmentTimeout('two-way'), {
    commandHealth: {
      state: 'unverified',
      message: 'RPC acknowledgment timed out; command outcome is unverified.',
    },
    command: {
      status: 'timeout',
      message: 'Command acknowledgment timed out; outcome is unverified.',
      result: {},
    },
  })

  const feedbackTimeout = commandAcknowledgmentTimeout('feedback-tag', 'FEEDBACK_TIMEOUT')
  assert.equal(feedbackTimeout.commandHealth.state, 'unverified')
  assert.equal(feedbackTimeout.command.status, 'timeout')
  assert.deepEqual(feedbackTimeout.command.result, { receipt: 'FEEDBACK_TIMEOUT' })
})
