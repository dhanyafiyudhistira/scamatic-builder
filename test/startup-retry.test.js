import test from 'node:test'
import assert from 'node:assert/strict'
import { retryDelayMs, retryStartup } from '../server/connectors/startup-retry.js'

test('startup retry uses bounded exponential backoff and eventually recovers', async () => {
  const retries = []
  let attempts = 0
  const result = await retryStartup(async () => {
    attempts += 1
    if (attempts < 4) throw new Error('transient')
    return 'ready'
  }, {
    initialDelayMs: 100,
    maxDelayMs: 250,
    onRetry: event => retries.push({ attempt: event.attempt, delayMs: event.delayMs }),
    sleep: async () => {},
  })
  assert.equal(result, 'ready')
  assert.deepEqual(retries, [
    { attempt: 1, delayMs: 100 },
    { attempt: 2, delayMs: 200 },
    { attempt: 3, delayMs: 250 },
  ])
  assert.equal(retryDelayMs(8, { initialDelayMs: 100, maxDelayMs: 250 }), 250)
})

test('startup retry fails fast for non-retryable configuration errors', async () => {
  let attempts = 0
  await assert.rejects(() => retryStartup(async () => {
    attempts += 1
    throw new Error('MONGO_URI env var is not set')
  }, {
    shouldRetry: () => false,
    sleep: async () => {},
  }), /MONGO_URI/)
  assert.equal(attempts, 1)
})

test('startup retry honors a finite attempt budget', async () => {
  let attempts = 0
  await assert.rejects(() => retryStartup(async () => {
    attempts += 1
    throw new Error('offline')
  }, {
    maxAttempts: 3,
    sleep: async () => {},
  }), /offline/)
  assert.equal(attempts, 3)
})
