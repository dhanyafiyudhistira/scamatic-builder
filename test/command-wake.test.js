import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { authorizeWorkerCommand, persistWorkerCommandAuthorization } from '../api/_handlers/commands.js'

test('worker authorization is durable and audited before the best-effort wake signal', async () => {
  const order = []
  const authorizedAt = new Date('2026-08-26T00:00:00.000Z')
  const session = { id: 'mongo-session' }
  const event = {
    _id: 'command-1',
    status: 'requested',
    authorizedAt: null,
  }
  const committed = { ...event, status: 'authorized', authorizedAt }

  const result = await persistWorkerCommandAuthorization({
    event,
    now: () => authorizedAt,
    transaction: work => work(session),
    audit: async activeSession => {
      assert.equal(activeSession, session)
      order.push('audit')
    },
    authorize: async (candidate, timestamp, activeSession) => {
      assert.equal(candidate, event)
      assert.equal(timestamp, authorizedAt)
      assert.equal(activeSession, session)
      order.push('authorize')
      return committed
    },
    onAuthorized: authorized => {
      assert.equal(authorized, committed)
      order.push('wake')
    },
  })

  assert.equal(result, committed)
  assert.deepEqual(order, ['audit', 'authorize', 'wake'])
})

test('an authorization audit failure leaves the command unclaimable and prevents wake', async () => {
  const failure = new Error('audit unavailable')
  let wakeCount = 0
  let authorizeCount = 0
  const event = { _id: 'command-2', status: 'requested' }

  await assert.rejects(
    persistWorkerCommandAuthorization({
      event,
      transaction: work => work(null),
      audit: async () => { throw failure },
      authorize: async () => { authorizeCount += 1 },
      onAuthorized: () => { wakeCount += 1 },
    }),
    failure,
  )
  assert.equal(event.status, 'requested')
  assert.equal(authorizeCount, 0)
  assert.equal(wakeCount, 0)
})

test('a failed wake signal never changes a durable command authorization result', async () => {
  const event = { _id: 'command-3', status: 'requested' }
  const committed = { ...event, status: 'authorized', authorizedAt: new Date() }
  const result = await persistWorkerCommandAuthorization({
    event,
    transaction: work => work(null),
    audit: async () => {},
    authorize: async () => committed,
    onAuthorized: () => { throw new Error('IPC unavailable') },
  })
  assert.equal(result, committed)
})

test('a lost authorization compare-and-set aborts without waking the worker', async () => {
  let wakeCount = 0
  await assert.rejects(
    persistWorkerCommandAuthorization({
      event: { _id: 'command-4', status: 'requested' },
      transaction: work => work(null),
      audit: async () => {},
      authorize: async () => null,
      onAuthorized: () => { wakeCount += 1 },
    }),
    error => error.code === 'COMMAND_AUTHORIZATION_STATE_CONFLICT',
  )
  assert.equal(wakeCount, 0)
})

test('a new worker command is inserted as authorized inside the active transaction', async () => {
  const session = { id: 'mongo-session' }
  const authorizedAt = new Date('2026-09-15T12:00:00.000Z')
  const event = {
    _id: 'command-atomic-create',
    isNew: true,
    toObject: () => ({ _id: 'command-atomic-create', status: 'requested', executionMode: 'worker' }),
  }
  let createCalls = 0
  const commandEvents = {
    async create(documents, options) {
      createCalls += 1
      assert.deepEqual(options, { session })
      assert.equal(documents[0].status, 'authorized')
      assert.equal(documents[0].authorizedAt, authorizedAt)
      return [{ toObject: () => documents[0] }]
    },
  }

  const result = await authorizeWorkerCommand(event, authorizedAt, session, commandEvents)

  assert.equal(createCalls, 1)
  assert.equal(result.status, 'authorized')
  assert.equal(result._id, 'command-atomic-create')
})

test('production wiring commits authorization with its audit before sending a targeted wake', async () => {
  const [commands, server, worker] = await Promise.all([
    readFile(new URL('../api/_handlers/commands.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/connector-worker.js', import.meta.url), 'utf8'),
  ])
  const authorization = commands.slice(
    commands.indexOf('export async function persistWorkerCommandAuthorization'),
    commands.indexOf('async function commandStatus'),
  )
  assert.match(authorization, /await transaction\(async session/)
  assert.ok(authorization.indexOf('await audit(session)') < authorization.indexOf('await authorize(event'))
  assert.match(authorization, /status: 'requested', executionMode: 'worker'/)
  assert.match(commands, /MONGO_TRANSACTIONS_REQUIRED[\s\S]*res\.status\(503\)/)
  assert.match(commands, /executionPlan\.executionMode === 'worker'[\s\S]*new CommandEvent\(eventFields\)/)
  assert.match(commands, /authorizationTransactionMs/)
  assert.match(server, /requestCommandPoll\(String\(event\?\._id \|\| ''\)\)/)
  assert.match(worker, /commandWakeBuffer\?\.take\(available\)/)
  assert.match(worker, /buildCommandCandidateFilter\(\{ pendingIds, targetedIds \}\)/)
})
