import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { persistWorkerCommandAuthorization } from '../api/_handlers/commands.js'

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
  assert.match(server, /requestCommandPoll\(event\?\._id\)/)
  assert.match(worker, /commandWakeBuffer\?\.take\(available\)/)
  assert.match(worker, /buildCommandCandidateFilter\(\{ pendingIds, targetedIds \}\)/)
})
