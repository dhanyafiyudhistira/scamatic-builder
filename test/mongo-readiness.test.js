import test from 'node:test'
import assert from 'node:assert/strict'
import { MongoOperationTimeoutError } from 'mongodb'
import mongoose from 'mongoose'
import { connectMongo, disconnectMongo, withMongoDeadline } from '../api/_lib/mongo.js'
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

test('a stale heartbeat shares recovery on the existing client and can retry after a failed ping', async t => {
  const previousUri = process.env.MONGO_URI
  process.env.MONGO_URI = 'mongodb://127.0.0.1/test'
  t.after(() => {
    if (previousUri === undefined) delete process.env.MONGO_URI
    else process.env.MONGO_URI = previousUri
  })

  const failure = new MongoOperationTimeoutError('MongoDB recovery ping timed out')
  let finishPing
  let pings = 0
  const connection = {
    readyState: 1,
    db: {
      admin: () => ({
        async command(request, options) {
          assert.deepEqual(request, { ping: 1 })
          assert.deepEqual(options, { timeoutMS: 8000 })
          pings += 1
          if (pings === 1) throw failure
          await new Promise(resolve => { finishPing = resolve })
        },
      }),
    },
  }
  const original = { connection }
  const initialConnect = t.mock.method(mongoose, 'connect', async () => original)
  const closeConnection = t.mock.method(mongoose, 'disconnect', async () => {})
  try {
    assert.equal(await connectMongo(), original)
    connection.readyState = 0
    await assert.rejects(connectMongo(), error => error === failure && isDatabaseUnavailableError(error))

    const first = connectMongo()
    const second = connectMongo()
    assert.equal(pings, 2)
    finishPing()
    assert.deepEqual(await Promise.all([first, second]), [original, original])
    assert.equal(initialConnect.mock.callCount(), 1)
  } finally {
    await disconnectMongo()
  }
  assert.equal(closeConnection.mock.callCount(), 1)
})
