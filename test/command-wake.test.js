import test from 'node:test'
import assert from 'node:assert/strict'
import { persistWorkerCommandAuthorization } from '../api/_handlers/commands.js'

test('worker authorization is durable and audited before the best-effort wake signal', async () => {
  const order = []
  const authorizedAt = new Date('2026-08-26T00:00:00.000Z')
  const event = {
    status: 'requested',
    authorizedAt: null,
    async save() { order.push('save') },
  }

  const result = await persistWorkerCommandAuthorization({
    event,
    now: () => authorizedAt,
    audit: async () => { order.push('audit') },
    onAuthorized: () => { order.push('wake') },
  })

  assert.equal(result, event)
  assert.equal(event.status, 'authorized')
  assert.equal(event.authorizedAt, authorizedAt)
  assert.deepEqual(order, ['save', 'audit', 'wake'])
})

test('an authorization audit failure prevents the eager wake signal', async () => {
  const failure = new Error('audit unavailable')
  let wakeCount = 0
  const event = { async save() {} }

  await assert.rejects(
    persistWorkerCommandAuthorization({
      event,
      audit: async () => { throw failure },
      onAuthorized: () => { wakeCount += 1 },
    }),
    failure,
  )
  assert.equal(wakeCount, 0)
})

test('a failed wake signal never changes a durable command authorization result', async () => {
  const event = { async save() {} }
  await assert.doesNotReject(persistWorkerCommandAuthorization({
    event,
    audit: async () => {},
    onAuthorized: () => { throw new Error('IPC unavailable') },
  }))
  assert.equal(event.status, 'authorized')
  assert.ok(event.authorizedAt instanceof Date)
})
