import test from 'node:test'
import assert from 'node:assert/strict'
import { withMongoDeadline } from '../api/_lib/mongo.js'
import { isDatabaseUnavailableError } from '../api/_lib/security.js'

test('MongoDB readiness checks return promptly when a connection attempt stalls', async () => {
  const stalled = new Promise(() => {})
  await assert.rejects(() => withMongoDeadline(stalled, 10), error => {
    assert.equal(error.code, 'MONGO_READINESS_TIMEOUT')
    assert.equal(error.name, 'MongoReadinessTimeoutError')
    assert.equal(isDatabaseUnavailableError(error), true)
    return true
  })
})

test('MongoDB readiness checks preserve successful results before the deadline', async () => {
  assert.deepEqual(await withMongoDeadline(Promise.resolve({ ready: true }), 100), { ready: true })
})
