import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { pollDeviceRpc, publishDeviceTelemetry, respondDeviceRpc, timestampedDeviceTelemetry } from '../api/_lib/thingsboard-device.js'

test('ThingsBoard device transport publishes telemetry, polls RPC, and responds two-way', async t => {
  const received = []
  const token = 'device-token-test'
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req)
    received.push({ url: req.url, method: req.method, body })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.method === 'GET') return res.end(JSON.stringify({ id: 27, method: 'setM_manualV205', params: true }))
    return res.end('{}')
  })
  await listen(server)
  t.after(() => close(server))
  const transport = { serverUrl: baseUrl(server), deviceToken: token }

  await publishDeviceTelemetry({ ...transport, values: timestampedDeviceTelemetry({ Valve_205: false }, 1_700_000_000_000, { now: 1_700_000_000_100 }) })
  const rpc = await pollDeviceRpc({ ...transport, longPollMs: 1000 })
  await respondDeviceRpc({ ...transport, requestId: rpc.id, payload: { success: true, status: 'acknowledged' } })

  assert.deepEqual(rpc, { id: 27, method: 'setM_manualV205', params: true })
  assert.deepEqual(received.map(item => item.method), ['POST', 'GET', 'POST'])
  assert.equal(received[0].url, `/api/v1/${token}/telemetry`)
  assert.deepEqual(JSON.parse(received[0].body), { ts: 1_700_000_000_000, values: { Valve_205: false } })
  assert.match(received[1].url, new RegExp(`^/api/v1/${token}/rpc\\?timeout=`))
  assert.equal(received[2].url, `/api/v1/${token}/rpc/27`)
  assert.deepEqual(JSON.parse(received[2].body), { success: true, status: 'acknowledged' })
})

test('timestamped telemetry rejects invalid and far-future clocks', () => {
  assert.throws(() => timestampedDeviceTelemetry({ Valve_205: true }, 0, { now: 1000 }), /timestamp is invalid/)
  assert.throws(() => timestampedDeviceTelemetry({ Valve_205: true }, 1_000_000, { now: 1000, maxSkewMs: 5000 }), /clock window/)
})

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}
function close(server) {
  return new Promise(resolve => server.close(resolve))
}
function baseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}
