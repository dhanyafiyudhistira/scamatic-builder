import test from 'node:test'
import assert from 'node:assert/strict'
import { coerceConnectorValue, normalizeTagEvent, publicConnector } from '../shared/connector-contract.js'
import { connectorSecretId, decryptConnectorSecret, encryptConnectorSecret } from '../api/_lib/connector-secrets.js'
import { exponentialBackoff } from '../server/connectors/backoff.js'
import { AsyncQueue } from '../server/connectors/async-queue.js'

test('normalized connector events coerce values and preserve isolation fields', () => {
  const event = normalizeTagEvent({ workspaceId: 'workspace-a', projectId: 'project-a', sourceId: 'source-a', tag: { id: 'motor', dataType: 'boolean' }, value: 'true', sourceTimestamp: '2026-07-21T00:00:00.000Z', sequence: 7 })
  assert.equal(event.value, true)
  assert.equal(event.quality, 'good')
  assert.equal(event.sequence, 7)
  assert.equal(event.projectId, 'project-a')
  assert.equal(coerceConnectorValue('1', 'boolean'), true)
  assert.equal(coerceConnectorValue('0', 'boolean'), false)
  assert.equal(coerceConnectorValue(' FALSE ', 'boolean'), false)
  assert.equal(coerceConnectorValue('ON', 'boolean'), true)
  assert.equal(coerceConnectorValue('off', 'boolean'), false)
  assert.throws(() => coerceConnectorValue('unknown', 'boolean'), /string value "unknown"/)
  assert.throws(() => coerceConnectorValue('not-a-number', 'number'))
})

test('connector secrets use authenticated envelope encryption', () => {
  const previous = process.env.SCADA_CONNECTOR_MASTER_KEY
  process.env.SCADA_CONNECTOR_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
  try {
    const encrypted = encryptConnectorSecret({ jwt: 'super-secret-thingsboard-token', deviceToken: 'device-token-secret' }, { connectorId: 'connector-a', environmentRef: 'staging' })
    assert.equal(JSON.stringify(encrypted).includes('super-secret'), false)
    assert.deepEqual(decryptConnectorSecret(encrypted, { connectorId: 'connector-a', environmentRef: 'staging' }), {
      jwt: 'super-secret-thingsboard-token',
      deviceToken: 'device-token-secret',
    })
    assert.throws(() => decryptConnectorSecret(encrypted, { connectorId: 'connector-b', environmentRef: 'staging' }))
    assert.equal(connectorSecretId('connector-a', 'staging').length, 64)
  } finally {
    if (previous == null) delete process.env.SCADA_CONNECTOR_MASTER_KEY
    else process.env.SCADA_CONNECTOR_MASTER_KEY = previous
  }
})

test('public connector projection normalizes legacy command offline without hiding liveness', () => {
  const value = publicConnector({ _id: 'c', projectId: 'p', name: 'TB', type: 'thingsboard', enabled: true, jwt: 'bad' }, { _id: 'e', environmentRef: 'staging', config: { serverUrl: 'https://tb.example' }, health: { state: 'online' }, commandHealth: { state: 'offline', message: 'Device responder timed out.' }, authentication: { mode: 'refresh-token', state: 'healthy', message: 'JWT auto-refresh is active.', accessTokenExpiresAt: new Date('2026-07-21T02:00:00Z'), refreshLeaseOwner: 'must-not-leak' }, secretConfiguredAt: new Date('2026-07-21T00:00:00Z'), deviceTokenConfiguredAt: new Date('2026-07-21T00:01:00Z'), payloadCiphertext: 'bad' })
  assert.equal(value.environment.secret.configured, true)
  assert.equal(value.environment.simulationSecret.configured, true)
  assert.equal(value.environment.health.state, 'online')
  assert.equal(value.environment.commandHealth.state, 'unverified')
  assert.equal(value.environment.authentication.mode, 'refresh-token')
  assert.equal(value.environment.authentication.state, 'healthy')
  assert.equal(JSON.stringify(value).includes('payloadCiphertext'), false)
  assert.equal(JSON.stringify(value).includes('"jwt"'), false)
  assert.equal(JSON.stringify(value).includes('refreshLeaseOwner'), false)
  assert.equal(JSON.stringify(value).includes('must-not-leak'), false)
})

test('backoff is capped and jitter stays bounded', () => {
  assert.equal(exponentialBackoff(0, { baseMs: 100, jitter: 0, random: () => 0 }), 100)
  assert.equal(exponentialBackoff(20, { baseMs: 100, maxMs: 1000, jitter: 0, random: () => 0 }), 1000)
  assert.equal(exponentialBackoff(2, { baseMs: 100, jitter: 0.25, random: () => 0 }), 300)
  assert.equal(exponentialBackoff(2, { baseMs: 100, jitter: 0.25, random: () => 1 }), 500)
})

test('async queue supports producer completion and async iteration', async () => {
  const queue = new AsyncQueue()
  queue.push('first'); queue.push('second'); queue.close()
  const values = []
  for await (const value of queue) values.push(value)
  assert.deepEqual(values, ['first', 'second'])
})
