import test from 'node:test'
import assert from 'node:assert/strict'
import { allowedOrigins, isAuthSessionRecordActive, requireAllowedOrigin, sessionPolicy } from '../api/_lib/auth.js'
import { resolveRuntimeStreamUrl, runtimeSessionPolicy } from '../api/_handlers/runtime-session.js'
import { isRuntimeStreamOriginAllowed } from '../server/connectors/runtime-stream-hub.js'

test('production origins fail closed while development retains local origins', () => {
  const previous = snapshotEnvironment(['NODE_ENV', 'APP_ORIGIN'])
  try {
    process.env.NODE_ENV = 'production'
    process.env.APP_ORIGIN = 'https://scada.example'
    assert.deepEqual(allowedOrigins(), ['https://scada.example'])
    assert.equal(isRuntimeStreamOriginAllowed('https://scada.example', allowedOrigins(), true), true)
    assert.equal(isRuntimeStreamOriginAllowed('http://localhost:5173', allowedOrigins(), true), false)
    assert.equal(isRuntimeStreamOriginAllowed('', allowedOrigins(), true), false)

    let status = null
    const res = { status(value) { status = value; return this }, json() { return this } }
    assert.equal(requireAllowedOrigin({ headers: {} }, res), false)
    assert.equal(status, 403)

    delete process.env.NODE_ENV
    delete process.env.APP_ORIGIN
    assert.equal(allowedOrigins().includes('http://localhost:5173'), true)
    assert.equal(isRuntimeStreamOriginAllowed('', allowedOrigins(), false), true)
  } finally {
    restoreEnvironment(previous)
  }
})

test('auth sessions enforce absolute and idle expiry', () => {
  const previous = snapshotEnvironment(['SCADA_SESSION_TTL_SECONDS', 'SCADA_SESSION_IDLE_SECONDS', 'SCADA_MAX_AUTH_SESSIONS'])
  try {
    process.env.SCADA_SESSION_TTL_SECONDS = '3600'
    process.env.SCADA_SESSION_IDLE_SECONDS = '300'
    process.env.SCADA_MAX_AUTH_SESSIONS = '4'
    const now = new Date('2026-07-26T12:00:00.000Z')
    assert.deepEqual(sessionPolicy(), { absoluteTtlMs: 3_600_000, idleTtlMs: 300_000, maxSessions: 4 })
    assert.equal(isAuthSessionRecordActive({ expiresAt: new Date(now.getTime() + 1_000), lastSeenAt: new Date(now.getTime() - 299_000), revokedAt: null }, now), true)
    assert.equal(isAuthSessionRecordActive({ expiresAt: new Date(now.getTime() + 1_000), lastSeenAt: new Date(now.getTime() - 301_000), revokedAt: null }, now), false)
    assert.equal(isAuthSessionRecordActive({ expiresAt: new Date(now.getTime() - 1), lastSeenAt: now, revokedAt: null }, now), false)
    assert.equal(isAuthSessionRecordActive({ expiresAt: new Date(now.getTime() + 1_000), lastSeenAt: now, revokedAt: now }, now), false)
  } finally {
    restoreEnvironment(previous)
  }
})

test('runtime stream URLs cannot rely on Host headers or insecure production protocols', () => {
  const previous = snapshotEnvironment(['NODE_ENV', 'APP_ORIGIN', 'PORT', 'CONNECTOR_STREAM_MODE', 'CONNECTOR_STREAM_PUBLIC_URL', 'CONNECTOR_STREAM_PORT'])
  try {
    delete process.env.NODE_ENV
    delete process.env.APP_ORIGIN
    delete process.env.CONNECTOR_STREAM_MODE
    delete process.env.CONNECTOR_STREAM_PUBLIC_URL
    process.env.CONNECTOR_STREAM_PORT = '3456'
    assert.equal(resolveRuntimeStreamUrl(), 'ws://localhost:3456/runtime-stream')

    process.env.NODE_ENV = 'production'
    assert.throws(() => resolveRuntimeStreamUrl(), /required/)
    process.env.CONNECTOR_STREAM_PUBLIC_URL = 'ws://stream.example/runtime-stream'
    assert.throws(() => resolveRuntimeStreamUrl(), /clean WebSocket URL/)
    process.env.CONNECTOR_STREAM_PUBLIC_URL = 'wss://stream.example/runtime-stream'
    assert.equal(resolveRuntimeStreamUrl(), 'wss://stream.example/runtime-stream')

    delete process.env.CONNECTOR_STREAM_PUBLIC_URL
    process.env.CONNECTOR_STREAM_MODE = 'embedded'
    process.env.APP_ORIGIN = 'https://scada.example'
    assert.equal(resolveRuntimeStreamUrl(), 'wss://scada.example/runtime-stream')
    process.env.APP_ORIGIN = 'http://scada.example'
    assert.throws(() => resolveRuntimeStreamUrl(), /clean HTTP origin/)

    delete process.env.NODE_ENV
    delete process.env.APP_ORIGIN
    process.env.PORT = '4567'
    assert.equal(resolveRuntimeStreamUrl(), 'ws://localhost:4567/runtime-stream')
  } finally {
    restoreEnvironment(previous)
  }
})

test('runtime session policy has bounded configurable lifetimes and caps', () => {
  const previous = snapshotEnvironment(['SCADA_RUNTIME_SESSION_SECONDS', 'SCADA_STREAM_TICKET_SECONDS', 'SCADA_MAX_RUNTIME_SESSIONS'])
  try {
    process.env.SCADA_RUNTIME_SESSION_SECONDS = '120'
    process.env.SCADA_STREAM_TICKET_SECONDS = '999'
    process.env.SCADA_MAX_RUNTIME_SESSIONS = '99'
    assert.deepEqual(runtimeSessionPolicy(), { ttlMs: 300_000, streamTicketTtlMs: 120_000, maxSessions: 20 })
  } finally {
    restoreEnvironment(previous)
  }
})

function snapshotEnvironment(names) {
  return Object.fromEntries(names.map(name => [name, process.env[name]]))
}
function restoreEnvironment(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value == null) delete process.env[name]
    else process.env[name] = value
  }
}
