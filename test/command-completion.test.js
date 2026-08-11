import test from 'node:test'
import assert from 'node:assert/strict'
import {
  flushPendingTerminalCommandAudits,
  persistAndPublishTerminalCommand,
  terminalCommandAuditId,
} from '../server/connectors/command-completion.js'

const event = {
  _id: 'command-1',
  requestId: 'request-1',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  versionId: 'version-a',
  actorId: 'operator-a',
  componentId: 'button-a',
  tagId: 'tag-a',
  status: 'dispatched',
  correlationId: 'correlation-1',
}

test('terminal command is persisted and pushed before its deferred audit write', async () => {
  const order = []
  const commandUpdates = []
  let releaseAudit
  let auditPromise
  const auditGate = new Promise(resolve => { releaseAudit = resolve })
  const completed = { ...event, status: 'acknowledged', terminalAuditPending: true, resultSummary: { message: 'Command acknowledged.' } }
  const commandEvents = {
    findOneAndUpdate(filter, update) {
      order.push('terminal-persist')
      commandUpdates.push({ filter, update })
      return { lean: async () => completed }
    },
    async updateOne(filter, update) {
      order.push('audit-pending-cleared')
      commandUpdates.push({ filter, update })
    },
  }
  const auditEvents = {
    async updateOne(filter) {
      order.push('audit-start')
      assert.equal(filter._id, terminalCommandAuditId(event._id, 'acknowledged'))
      await auditGate
      order.push('audit-finish')
    },
  }
  const hub = { publishCommand(command) { order.push('websocket-push'); assert.equal(command.status, 'acknowledged') } }

  const result = await persistAndPublishTerminalCommand({
    hub,
    event,
    status: 'acknowledged',
    message: 'Command acknowledged.',
    timing: {
      acknowledgmentMode: 'two-way',
      upstreamStartedAt: '2026-08-10T00:00:00.500Z',
      upstreamCompletedAt: '2026-08-10T00:00:00.900Z',
    },
    commandEvents,
    auditEvents,
    scheduleAudit: promise => { auditPromise = promise },
  })

  assert.equal(result, completed)
  assert.deepEqual(order, ['terminal-persist', 'websocket-push', 'audit-start'])
  assert.deepEqual(commandUpdates[0].filter.status.$in, ['dispatched', 'accepted_by_gateway'])
  assert.equal(commandUpdates[0].update.$set.terminalAuditPending, true)
  assert.equal(commandUpdates[0].update.$set.acknowledgmentMode, 'two-way')
  assert.equal(commandUpdates[0].update.$set.upstreamStartedAt.toISOString(), '2026-08-10T00:00:00.500Z')
  assert.equal(commandUpdates[0].update.$set.upstreamCompletedAt.toISOString(), '2026-08-10T00:00:00.900Z')

  releaseAudit()
  await auditPromise
  assert.deepEqual(order, ['terminal-persist', 'websocket-push', 'audit-start', 'audit-finish', 'audit-pending-cleared'])
  assert.equal(commandUpdates[1].update.$set.terminalAuditPending, false)
})

test('a stale completion cannot overwrite an existing terminal command', async () => {
  let pushed = false
  let auditScheduled = false
  const commandEvents = {
    findOneAndUpdate() { return { lean: async () => null } },
  }
  const result = await persistAndPublishTerminalCommand({
    hub: { publishCommand() { pushed = true } },
    event,
    status: 'failed',
    message: 'Late failure.',
    commandEvents,
    auditEvents: {},
    scheduleAudit: () => { auditScheduled = true },
  })
  assert.equal(result, null)
  assert.equal(pushed, false)
  assert.equal(auditScheduled, false)
})

test('a failed deferred audit requests immediate recovery without delaying terminal persistence', async () => {
  const completed = { ...event, status: 'failed', terminalAuditPending: true }
  let auditPromise
  let recoveryRequests = 0
  const commandEvents = {
    findOneAndUpdate() { return { lean: async () => completed } },
  }
  const auditError = Object.assign(new Error('audit unavailable'), { code: 'AUDIT_DOWN' })

  const result = await persistAndPublishTerminalCommand({
    hub: { publishCommand() {} },
    event,
    status: 'failed',
    message: 'Command failed.',
    commandEvents,
    auditEvents: { async updateOne() { throw auditError } },
    scheduleAudit: (promise, onError) => { auditPromise = promise.catch(onError) },
    onAuditError: () => {},
    onAuditDeferred: error => { assert.equal(error, auditError); recoveryRequests += 1 },
  })

  assert.equal(result, completed)
  assert.equal(recoveryRequests, 0)
  await auditPromise
  assert.equal(recoveryRequests, 1)
})

test('pending terminal audits are replayed idempotently', async () => {
  const pending = [{ ...event, status: 'rejected', terminalAuditPending: true }]
  const auditIds = []
  const cleared = []
  const commandEvents = {
    find() {
      return { sort() { return this }, limit() { return this }, lean: async () => pending }
    },
    async updateOne(filter) { cleared.push(filter._id) },
  }
  const auditEvents = { async updateOne(filter) { auditIds.push(filter._id) } }

  assert.equal(await flushPendingTerminalCommandAudits({ commandEvents, auditEvents }), 1)
  assert.deepEqual(auditIds, [terminalCommandAuditId(event._id, 'rejected')])
  assert.deepEqual(cleared, [event._id])
})
