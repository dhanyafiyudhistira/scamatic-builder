import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress, normalizeConnectorServerUrl } from '../api/_lib/connector-target.js'
import { normalizeTelemetryEntries, normalizeTelemetryQuery } from '../api/_handlers/telemetry.js'
import { clientAddress } from '../api/_lib/security.js'

test('connector targets reject credential, query, and non-allowlisted production URLs', () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    allowedHosts: process.env.CONNECTOR_ALLOWED_HOSTS,
  }
  try {
    delete process.env.NODE_ENV
    assert.equal(normalizeConnectorServerUrl('http://localhost:8080/'), 'http://localhost:8080')
    assert.throws(() => normalizeConnectorServerUrl('https://user:pass@tb.example'))
    assert.throws(() => normalizeConnectorServerUrl('https://tb.example?next=http://internal'))

    process.env.NODE_ENV = 'production'
    process.env.CONNECTOR_ALLOWED_HOSTS = 'tb.example'
    assert.equal(normalizeConnectorServerUrl('https://tb.example/'), 'https://tb.example')
    assert.throws(() => normalizeConnectorServerUrl('https://other.example'))
    assert.throws(() => normalizeConnectorServerUrl('http://tb.example'))
  } finally {
    restoreEnvironment('NODE_ENV', previous.nodeEnv)
    restoreEnvironment('CONNECTOR_ALLOWED_HOSTS', previous.allowedHosts)
  }
})

test('private and reserved connector addresses are classified conservatively', () => {
  for (const address of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.5', '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false)
})

test('telemetry validation enforces bounded project-scoped numeric samples', () => {
  const query = normalizeTelemetryQuery({ tags: 'level,temp,level', minutes: '15', limit: '250' })
  assert.deepEqual(query, { tags: ['level', 'temp'], minutes: 15, limit: 250 })
  const points = normalizeTelemetryEntries([{ tag: 'level', value: '42.5', timestamp: 1_000_000 }], { workspaceId: 'w', projectId: 'p', now: 1_000_000 })
  assert.equal(points[0].workspaceId, 'w')
  assert.equal(points[0].projectId, 'p')
  assert.equal(points[0].value, 42.5)
  assert.throws(() => normalizeTelemetryQuery({ tags: 'bad tag', minutes: '60', limit: '400' }))
  assert.throws(() => normalizeTelemetryEntries([{ tag: 'level', value: 'NaN' }], { workspaceId: 'w', projectId: 'p' }))
})

test('client address prefers the proxy-normalized request ip', () => {
  assert.equal(clientAddress({ ip: '203.0.113.8', headers: { 'x-forwarded-for': '10.0.0.1' } }), '203.0.113.8')
  assert.equal(clientAddress({ headers: { 'x-real-ip': '203.0.113.9' } }), '203.0.113.9')
})

function restoreEnvironment(name, value) {
  if (value == null) delete process.env[name]
  else process.env[name] = value
}
