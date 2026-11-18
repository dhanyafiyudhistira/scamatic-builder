import test from 'node:test'
import assert from 'node:assert/strict'
import { persistSimulationCommandCompletion } from '../api/_handlers/commands.js'

function simulationEvent() {
  const value = {
    _id: 'command-simulation-1',
    requestId: 'request-simulation-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    versionId: 'version-1',
    componentId: 'component-1',
    tagId: 'tag-1',
    actorId: 'user-1',
    executionMode: 'mock',
    status: 'requested',
    action: 'toggle-boolean',
    correlationId: 'correlation-1',
  }
  return { ...value, toObject: () => ({ ...value }) }
}

test('Simulation completion persists one final command and both audits in one transaction', async () => {
  const event = simulationEvent()
  const session = { id: 'mongo-session' }
  const times = [
    new Date('2026-09-20T01:00:00.000Z'),
    new Date('2026-09-20T01:00:00.001Z'),
    new Date('2026-09-20T01:00:00.002Z'),
  ]
  const calls = []
  const result = await persistSimulationCommandCompletion({
    event,
    result: { ok: true, message: 'Command acknowledged.', value: true, resetAfterMs: null },
    principal: { id: 'user-1', workspaceId: 'workspace-1' },
    sourceId: 'source-1',
    now: () => times.shift(),
    transaction: async work => {
      calls.push('transaction')
      return work(session)
    },
    auditEvents: {
      async insertMany(documents, options) {
        calls.push('audits')
        assert.deepEqual(options, { ordered: true, session })
        assert.deepEqual(documents.map(document => document.action), ['command.authorized', 'command.acknowledged'])
        assert.equal(documents[0].metadata.sourceId, 'source-1')
      },
    },
    commandEvents: {
      async create(documents, options) {
        calls.push('command')
        assert.deepEqual(options, { session })
        assert.equal(documents.length, 1)
        assert.equal(documents[0].status, 'acknowledged')
        assert.equal(documents[0].resultSummary.value, true)
        assert.equal(documents[0].authorizedAt.toISOString(), '2026-09-20T01:00:00.000Z')
        assert.equal(documents[0].completedAt.toISOString(), '2026-09-20T01:00:00.002Z')
        return [{ toObject: () => ({ ...documents[0], createdAt: new Date('2026-09-20T01:00:00.003Z') }) }]
      },
    },
  })

  assert.deepEqual(calls, ['transaction', 'audits', 'command'])
  assert.equal(result.status, 'acknowledged')
  assert.equal(result.resultSummary.value, true)
})

test('Simulation completion never writes the command when its atomic audit batch fails', async () => {
  const failure = new Error('audit unavailable')
  let commandWrites = 0

  await assert.rejects(
    persistSimulationCommandCompletion({
      event: simulationEvent(),
      result: { ok: true, message: 'Command acknowledged.', value: true },
      principal: { id: 'user-1', workspaceId: 'workspace-1' },
      transaction: work => work({ id: 'mongo-session' }),
      auditEvents: { insertMany: async () => { throw failure } },
      commandEvents: { create: async () => { commandWrites += 1 } },
    }),
    failure,
  )

  assert.equal(commandWrites, 0)
})
