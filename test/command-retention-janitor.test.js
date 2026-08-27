import test from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireRetentionLease,
  CommandRetentionJanitor,
  markExpiredCommandsForPurge,
  purgeExpiredCommands,
  retentionIndexExists,
} from '../server/connectors/command-retention-janitor.js'
import { commandRetentionPolicy } from '../shared/command-retention.js'

const policy = commandRetentionPolicy({
  COMMAND_RETENTION_ENABLED: 'true',
  COMMAND_RETENTION_ACK_DAYS: '90',
  COMMAND_RETENTION_FAILURE_DAYS: '90',
  COMMAND_RETENTION_BATCH_SIZE: '100',
  COMMAND_RETENTION_QUERY_MAX_TIME_MS: '1000',
})

test('purge deletes bounded eligible commands but preserves acknowledged state without a snapshot', async () => {
  const candidates = [
    command('failed-1', 'failed', 'project-a', 'tag-a'),
    command('ack-safe', 'acknowledged', 'project-a', 'tag-a'),
    command('ack-protected', 'acknowledged', 'project-b', 'tag-b'),
  ]
  let deleteFilter
  let protectedUpdate
  const commandEvents = {
    find: () => query(candidates),
    async bulkWrite(operations) {
      protectedUpdate = operations
      return { modifiedCount: operations.length }
    },
    async deleteMany(filter) {
      deleteFilter = filter
      return { deletedCount: 2 }
    },
  }
  const tagValueSnapshots = {
    find: () => query([{ projectId: 'project-a', tagId: 'tag-a' }]),
  }
  const result = await purgeExpiredCommands({
    commandEvents,
    tagValueSnapshots,
    policy,
    now: new Date('2026-08-01T00:00:00.000Z'),
  })
  assert.equal(result.deletedCount, 2)
  assert.equal(result.stateProtected, 1)
  assert.deepEqual(deleteFilter._id.$in, ['failed-1', 'ack-safe'])
  assert.equal(protectedUpdate[0].updateOne.filter._id, 'ack-protected')
  assert.equal(protectedUpdate[0].updateOne.update.$set.purgeAt.toISOString(), '2026-08-31T00:00:00.000Z')
})

test('backfill marks only terminal commands with matching durable audits', async () => {
  const completedAt = new Date('2026-01-01T00:00:00.000Z')
  const byStatus = {
    acknowledged: [{ ...command('ack-audited', 'acknowledged'), completedAt, createdAt: completedAt, correlationId: 'corr-a', requestId: 'req-a' }],
    rejected: [],
    failed: [{ ...command('failed-no-audit', 'failed'), completedAt, createdAt: completedAt, correlationId: 'corr-b', requestId: 'req-b' }],
  }
  let operations
  const commandEvents = {
    find: filter => query(byStatus[filter.status] || []),
    async bulkWrite(value) {
      operations = value
      return { modifiedCount: value.length }
    },
  }
  const auditEvents = {
    find: () => query([{ correlationId: 'corr-a', action: 'command.acknowledged', metadata: { requestId: 'req-a' } }]),
  }
  const result = await markExpiredCommandsForPurge({
    commandEvents,
    auditEvents,
    policy,
    now: new Date('2026-08-01T00:00:00.000Z'),
  })
  assert.equal(result.candidateCount, 2)
  assert.equal(result.markedCount, 1)
  assert.equal(result.auditProtected, 1)
  assert.equal(operations[0].updateOne.filter._id, 'ack-audited')
  assert.equal(operations[0].updateOne.update.$set.purgeAt.toISOString(), '2026-04-01T00:00:00.000Z')
})

test('lease contention fails closed on a duplicate-key race', async () => {
  const duplicate = Object.assign(new Error('duplicate'), { code: 11000 })
  const leases = {
    findOneAndUpdate() { return { lean: async () => { throw duplicate } } },
  }
  assert.equal(await acquireRetentionLease({ leases, ownerId: 'owner-a' }), false)
})

test('janitor refuses cleanup when the explicit purgeAt index is missing', async () => {
  let leaseAttempted = false
  const errors = []
  const janitor = new CommandRetentionJanitor({
    commandEvents: { collection: { async indexes() { return [] } } },
    leases: { findOneAndUpdate() { leaseAttempted = true } },
    connect: async () => {},
    environment: { COMMAND_RETENTION_ENABLED: 'true' },
    logger: { log() {}, error(message) { errors.push(message) } },
  })
  const result = await janitor.runOnce()
  assert.equal(result.skipped, 'index-missing')
  assert.equal(leaseAttempted, false)
  assert.equal(errors.length, 1)
  await janitor.close()
})

test('retention index validation rejects a same-name index with unsafe options', async () => {
  assert.equal(await retentionIndexExists({
    collection: { async indexes() { return [{ name: 'command_purge_at_1', key: { purgeAt: 1 } }] } },
  }), false)
  assert.equal(await retentionIndexExists({
    collection: { async indexes() { return [{ name: 'command_purge_at_1', key: { purgeAt: 1 }, partialFilterExpression: { purgeAt: { $exists: true } } }] } },
  }), true)
})

function command(_id, status, projectId = 'project-a', tagId = 'tag-a') {
  return {
    _id,
    requestId: `request-${_id}`,
    projectId,
    tagId,
    correlationId: `correlation-${_id}`,
    status,
    executionMode: 'worker',
    terminalAuditPending: false,
    purgeAt: new Date('2026-01-01T00:00:00.000Z'),
  }
}

function query(value) {
  return {
    sort() { return this },
    limit() { return this },
    maxTimeMS() { return this },
    select() { return this },
    lean: async () => value,
  }
}
