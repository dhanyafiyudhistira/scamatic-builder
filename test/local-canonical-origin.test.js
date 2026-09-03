import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalLocalNavigationUrl, isLoopbackAddress, resolveServerBindHost } from '../server/local-canonical-origin.js'

const canonical = 'http://127.0.0.1:3001'

test('localhost browser navigation redirects to the canonical loopback origin', () => {
  assert.equal(canonicalLocalNavigationUrl({
    method: 'GET',
    host: 'localhost:3001',
    accept: 'text/html,application/xhtml+xml',
    fetchMode: 'navigate',
    originalUrl: '/projects/mixing-unit?mode=builder',
  }, canonical), 'http://127.0.0.1:3001/projects/mixing-unit?mode=builder')
})

test('canonical redirects do not affect API requests or non-localhost hosts', () => {
  assert.equal(canonicalLocalNavigationUrl({ method: 'GET', host: 'localhost:3001', accept: 'application/json', fetchMode: 'cors', originalUrl: '/api/connectors' }, canonical), null)
  assert.equal(canonicalLocalNavigationUrl({ method: 'GET', host: '127.0.0.1:3001', accept: 'text/html', fetchMode: 'navigate', originalUrl: '/' }, canonical), null)
  assert.equal(canonicalLocalNavigationUrl({ method: 'GET', host: 'localhost.attacker.example:3001', accept: 'text/html', fetchMode: 'navigate', originalUrl: '/' }, canonical), null)
  assert.equal(canonicalLocalNavigationUrl({ method: 'GET', host: 'localhost:3001', accept: 'text/html', fetchMode: 'navigate', originalUrl: '//attacker.example' }, canonical), null)
})

test('the local server binds to IPv4 loopback unless network exposure is explicit', () => {
  assert.equal(resolveServerBindHost(), '127.0.0.1')
  assert.equal(resolveServerBindHost('localhost'), '127.0.0.1')
  assert.equal(resolveServerBindHost('127.0.0.1'), '127.0.0.1')
  assert.equal(resolveServerBindHost('0.0.0.0'), '0.0.0.0')
  assert.throws(() => resolveServerBindHost('scada.example'), /SCAMATIC_BIND_HOST/)
})

test('sensitive local health checks recognize only direct loopback peers', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.20'), false)
  assert.equal(isLoopbackAddress(''), false)
})
