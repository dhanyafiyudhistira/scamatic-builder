import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  readThingsBoardLatestTelemetry,
  sendThingsBoardRpc,
  telemetryEventFromLatest,
  waitForThingsBoardFeedback,
} from '../api/_lib/thingsboard-serverless.js'

test('serverless ThingsBoard transport supports definitive two-way and accepted one-way RPC', async t => {
  const token = 'serverless-test-token'
  const deviceId = '00000000-0000-0000-0000-000000000010'
  const received = []
  const server = http.createServer(async (req, res) => {
    if (req.headers['x-authorization'] !== `Bearer ${token}`) {
      res.writeHead(401); return res.end()
    }
    if (req.url === `/api/plugins/rpc/twoway/${deviceId}` || req.url === `/api/plugins/rpc/oneway/${deviceId}`) {
      const body = await readJson(req)
      received.push({ url: req.url, body })
      if (req.url.includes('/twoway/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, applied: body.params }))
      }
      res.writeHead(200); return res.end()
    }
    res.writeHead(404); res.end()
  })
  await listen(server)
  t.after(() => close(server))
  const config = { serverUrl: baseUrl(server), deviceId }
  const validateTarget = async value => value

  const twoWay = await sendThingsBoardRpc({ config, jwt: token, method: 'setTrigger_Auto', params: true, timeoutMs: 1000, mode: 'two-way', validateTarget })
  assert.equal(twoWay.acknowledged, true)
  assert.deepEqual(twoWay.result, { ok: true, applied: true })

  const oneWay = await sendThingsBoardRpc({ config, jwt: token, method: 'setM_manualV205', params: false, timeoutMs: 1000, mode: 'feedback-tag', validateTarget })
  assert.deepEqual(oneWay, { accepted: true, acknowledged: false, code: 'ACCEPTED_BY_GATEWAY' })
  assert.deepEqual(received.map(item => item.body.method), ['setTrigger_Auto', 'setM_manualV205'])
})

test('serverless ThingsBoard transport preserves RPC timeout as unverified input', async t => {
  const deviceId = '00000000-0000-0000-0000-000000000011'
  const server = http.createServer((req, res) => { res.writeHead(504); res.end() })
  await listen(server)
  t.after(() => close(server))

  const receipt = await sendThingsBoardRpc({
    config: { serverUrl: baseUrl(server), deviceId },
    jwt: 'token',
    method: 'setReset',
    params: true,
    timeoutMs: 1000,
    mode: 'two-way',
    validateTarget: async value => value,
  })
  assert.deepEqual(receipt, { accepted: true, acknowledged: false, timedOut: true, code: 'HTTP_504' })
})

test('serverless telemetry reads latest values and feedback waits for the expected readback', async t => {
  const token = 'serverless-test-token'
  const deviceId = '00000000-0000-0000-0000-000000000012'
  let reads = 0
  const server = http.createServer((req, res) => {
    if (req.headers['x-authorization'] !== `Bearer ${token}`) {
      res.writeHead(401); return res.end()
    }
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`) {
      reads += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        Valve_205: [{ ts: 1_700_000_000_000 + reads, value: reads > 1 ? 'true' : 'false' }],
      }))
    }
    res.writeHead(404); res.end()
  })
  await listen(server)
  t.after(() => close(server))
  const config = { serverUrl: baseUrl(server), deviceId }
  const readLatest = input => readThingsBoardLatestTelemetry({ ...input, fetchImpl: fetch, validateTarget: async value => value })

  const first = await readLatest({ config, jwt: token, keys: ['Valve_205'], timeoutMs: 1000 })
  assert.equal(first.Valve_205.value, 'false')

  const feedback = await waitForThingsBoardFeedback({
    config,
    jwt: token,
    key: 'Valve_205',
    dataType: 'boolean',
    expectedValue: true,
    timeoutMs: 500,
    pollIntervalMs: 10,
    readLatest,
  })
  assert.equal(feedback.matched, true)
  assert.equal(feedback.sample.value, true)

  const event = telemetryEventFromLatest({
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    sourceId: 'source-a',
    tag: { id: 'tb.valve_205', dataType: 'boolean' },
    sample: feedback.sample,
  })
  assert.equal(event.tagId, 'tb.valve_205')
  assert.equal(event.value, true)
  assert.equal(event.quality, 'good')
})

test('feedback ignores a matching value that predates command dispatch', async () => {
  let reads = 0
  const samples = [
    { timestamp: 100, value: true },
    { timestamp: 201, value: true },
  ]
  const feedback = await waitForThingsBoardFeedback({
    config: {},
    jwt: 'unused',
    key: 'Valve_205',
    dataType: 'boolean',
    expectedValue: true,
    afterTimestamp: 200,
    timeoutMs: 100,
    pollIntervalMs: 1,
    readLatest: async () => ({ Valve_205: samples[Math.min(reads++, samples.length - 1)] }),
  })
  assert.equal(feedback.matched, true)
  assert.equal(feedback.sample.timestamp, 201)
  assert.equal(reads, 2)
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
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
    req.on('error', reject)
  })
}
