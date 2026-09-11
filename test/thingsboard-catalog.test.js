import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverThingsBoardTelemetry, getThingsBoardDevice, inferTelemetryType, listThingsBoardDevices } from '../api/_lib/thingsboard-catalog.js'

const deviceId = 'b1523ea0-65f2-11ee-8c99-0242ac120002'
const validateTarget = async value => value

test('ThingsBoard catalog bounds device results and returns public metadata only', async () => {
  let requestedUrl = ''
  let requestedHeaders
  const result = await listThingsBoardDevices({
    serverUrl: 'https://tb.example.test', jwt: 'private-jwt', textSearch: 'Mixer', validateTarget,
    fetchImpl: async (url, options) => {
      requestedUrl = url
      requestedHeaders = options.headers
      return { ok: true, json: async () => ({ data: [{ id: { id: deviceId }, name: 'Mixer-01', label: 'Main mixer', type: 'mixer', customerId: 'secret-scope' }], totalElements: 1, totalPages: 1, hasNext: false }) }
    },
  })
  assert.match(requestedUrl, /textSearch=Mixer/)
  assert.equal(requestedHeaders['X-Authorization'], 'Bearer private-jwt')
  assert.deepEqual(result.devices[0], { id: deviceId, name: 'Mixer-01', label: 'Main mixer', type: 'mixer', createdTime: null })
  assert.equal('customerId' in result.devices[0], false)
})

test('ThingsBoard telemetry discovery infers safe tag types and limits samples', async () => {
  const fetchImpl = async url => {
    if (url.includes('/keys/')) return { ok: true, json: async () => ['temperature', 'running', 'message'] }
    return { ok: true, json: async () => ({ temperature: [{ ts: 10, value: '21.5' }], running: [{ ts: 11, value: true }], message: [{ ts: 12, value: 'ready' }] }) }
  }
  const result = await discoverThingsBoardTelemetry({ serverUrl: 'https://tb.example.test', jwt: 'jwt', deviceId, fetchImpl, validateTarget })
  assert.deepEqual(result.keys.map(item => [item.key, item.dataType]), [['temperature', 'number'], ['running', 'boolean'], ['message', 'string']])
  assert.equal(inferTelemetryType('2026-09-11T10:00:00Z'), 'datetime')
})

test('ThingsBoard device lookup rejects mismatched upstream identity', async () => {
  await assert.rejects(
    getThingsBoardDevice({ serverUrl: 'https://tb.example.test', jwt: 'jwt', deviceId, validateTarget, fetchImpl: async () => ({ ok: true, json: async () => ({ id: { id: 'other-device-id' }, name: 'Wrong' }) }) }),
    /invalid device/,
  )
})
