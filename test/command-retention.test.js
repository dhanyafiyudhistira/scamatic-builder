import test from 'node:test'
import assert from 'node:assert/strict'
import {
  commandPurgeAt,
  commandRetentionCutoff,
  commandRetentionPolicy,
} from '../shared/command-retention.js'

const enabledPolicy = commandRetentionPolicy({
  COMMAND_RETENTION_ENABLED: 'true',
  COMMAND_RETENTION_ACK_DAYS: '90',
  COMMAND_RETENTION_FAILURE_DAYS: '120',
})

test('retention policy is disabled by default and clamps unsafe settings', () => {
  assert.equal(commandRetentionPolicy({}).enabled, false)
  const bounded = commandRetentionPolicy({
    COMMAND_RETENTION_ENABLED: 'true',
    COMMAND_RETENTION_ACK_DAYS: '1',
    COMMAND_RETENTION_BATCH_SIZE: '99999',
    COMMAND_RETENTION_INTERVAL_MS: '10',
  })
  assert.equal(bounded.acknowledgedDays, 30)
  assert.equal(bounded.batchSize, 500)
  assert.equal(bounded.intervalMs, 60_000)
})

test('only audited live terminal commands receive purgeAt', () => {
  const completedAt = new Date('2026-01-01T00:00:00.000Z')
  assert.equal(commandPurgeAt({ status: 'acknowledged', executionMode: 'worker', completedAt }, { policy: enabledPolicy }).toISOString(), '2026-04-01T00:00:00.000Z')
  assert.equal(commandPurgeAt({ status: 'failed', executionMode: 'serverless', completedAt }, { policy: enabledPolicy }).toISOString(), '2026-05-01T00:00:00.000Z')
  assert.equal(commandPurgeAt({ status: 'timeout', executionMode: 'worker', completedAt }, { policy: enabledPolicy }), null)
  assert.equal(commandPurgeAt({ status: 'acknowledged', executionMode: 'mock', completedAt }, { policy: enabledPolicy }), null)
  assert.equal(commandPurgeAt({ status: 'acknowledged', executionMode: 'worker', completedAt, terminalAuditPending: true }, { policy: enabledPolicy }), null)
  assert.equal(commandPurgeAt({ status: 'dispatched', executionMode: 'worker', completedAt }, { policy: enabledPolicy }), null)
})

test('retention cutoff follows the status-specific policy', () => {
  const now = new Date('2026-08-01T00:00:00.000Z')
  assert.equal(commandRetentionCutoff('acknowledged', { policy: enabledPolicy, now }).toISOString(), '2026-05-03T00:00:00.000Z')
  assert.equal(commandRetentionCutoff('failed', { policy: enabledPolicy, now }).toISOString(), '2026-04-03T00:00:00.000Z')
  assert.equal(commandRetentionCutoff('timeout', { policy: enabledPolicy, now }), null)
})
