import test from 'node:test'
import assert from 'node:assert/strict'
import { apiMongoWarmupConfig, warmApiMongo } from '../server/api-mongo-warmup.js'

test('API MongoDB warm-up stays alive through a cold-start outage and becomes ready', async () => {
  const states = []
  let attempts = 0
  const connection = await warmApiMongo({
    connect: async () => {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
      return { ready: true }
    },
    shouldRetry: error => error.code === 'ECONNREFUSED',
    env: {
      API_MONGO_STARTUP_MAX_ATTEMPTS: '0',
      API_MONGO_RETRY_INITIAL_MS: '100',
      API_MONGO_RETRY_MAX_MS: '200',
    },
    sleep: async () => {},
    onState: state => states.push(state),
  })

  assert.deepEqual(connection, { ready: true })
  assert.equal(attempts, 3)
  assert.deepEqual(states.map(state => state.phase), [
    'connecting-mongodb',
    'retrying-mongodb',
    'connecting-mongodb',
    'retrying-mongodb',
    'connecting-mongodb',
    'ready',
  ])
  assert.deepEqual(states.filter(state => state.phase === 'retrying-mongodb').map(state => state.delayMs), [100, 200])
})

test('API MongoDB warm-up fails fast for a configuration error', async () => {
  const states = []
  let attempts = 0
  await assert.rejects(() => warmApiMongo({
    connect: async () => {
      attempts += 1
      throw new Error('MONGO_URI env var is not set')
    },
    shouldRetry: () => false,
    sleep: async () => {},
    onState: state => states.push(state),
  }), /MONGO_URI/)

  assert.equal(attempts, 1)
  assert.equal(states.at(-1).phase, 'failed')
})

test('API MongoDB warm-up configuration is bounded and defaults to infinite retry', () => {
  assert.deepEqual(apiMongoWarmupConfig({}), {
    maxAttempts: 0,
    initialDelayMs: 500,
    maxDelayMs: 10_000,
  })
  assert.deepEqual(apiMongoWarmupConfig({
    API_MONGO_STARTUP_MAX_ATTEMPTS: '4',
    API_MONGO_RETRY_INITIAL_MS: '250',
    API_MONGO_RETRY_MAX_MS: '4000',
  }), {
    maxAttempts: 4,
    initialDelayMs: 250,
    maxDelayMs: 4000,
  })
})
