import test from 'node:test'
import assert from 'node:assert/strict'
import { assertMongoTransactionsSupported, mongoTransactionsRequiredError } from '../api/_lib/mongo.js'

const connectionFor = hello => ({
  connection: {
    db: {
      admin: () => ({ command: async command => {
        assert.deepEqual(command, { hello: 1 })
        return hello
      } }),
    },
  },
})

test('MongoDB transaction capability accepts replica sets and sharded clusters', async () => {
  assert.deepEqual(await assertMongoTransactionsSupported(connectionFor({
    setName: 'atlas-example-shard-0',
    logicalSessionTimeoutMinutes: 30,
    maxWireVersion: 21,
  })), { topology: 'replica-set', transactions: 'supported' })

  assert.deepEqual(await assertMongoTransactionsSupported(connectionFor({
    msg: 'isdbgrid',
    logicalSessionTimeoutMinutes: 30,
    maxWireVersion: 21,
  })), { topology: 'sharded', transactions: 'supported' })
})

test('MongoDB transaction capability rejects standalone and obsolete deployments', async () => {
  for (const hello of [
    { logicalSessionTimeoutMinutes: 30, maxWireVersion: 21 },
    { setName: 'legacy', logicalSessionTimeoutMinutes: 30, maxWireVersion: 6 },
    { msg: 'isdbgrid', logicalSessionTimeoutMinutes: 30, maxWireVersion: 7 },
    { setName: 'sessions-disabled', maxWireVersion: 21 },
  ]) {
    await assert.rejects(() => assertMongoTransactionsSupported(connectionFor(hello)), error => {
      assert.equal(error.code, 'MONGO_TRANSACTIONS_REQUIRED')
      assert.equal(error.statusCode, 503)
      assert.match(error.message, /Atlas or a transaction-capable replica set/)
      return true
    })
  }
})

test('transaction requirement errors retain their original MongoDB cause', () => {
  const cause = new Error('Transaction numbers are only allowed on a replica set member or mongos')
  const error = mongoTransactionsRequiredError(cause)
  assert.equal(error.code, 'MONGO_TRANSACTIONS_REQUIRED')
  assert.equal(error.statusCode, 503)
  assert.equal(error.cause, cause)
})
