import test from 'node:test'
import assert from 'node:assert/strict'
import { GENERIC_NODE_RED_FLOW as flow } from './helpers/node-red-flow-fixture.js'

test('Node-RED flow uses one RPC subscription and publishes correlated responses', () => {
  const subscriptions = flow.filter(node => node.type === 'mqtt in' && node.topic === 'v1/devices/me/rpc/request/+')
  assert.equal(subscriptions.length, 1)

  const parser = flow.find(node => node.id === 'rpc-parser')
  const validator = flow.find(node => node.id === 'rpc-validator')
  const response = flow.find(node => node.id === 'rpc-response')
  assert.ok(parser.wires[0].includes(validator.id))
  assert.ok(validator.wires[1].includes(response.id))
  assert.equal(response.type, 'mqtt out')
})

test('Node-RED RPC validation normalizes accepted payloads and rejects invalid requests', () => {
  const validator = flow.find(node => node.id === 'rpc-validator')
  const validate = new Function('msg', validator.func)

  const [acceptedCommand, acceptedResponse] = validate({
    topic: 'v1/devices/me/rpc/request/205',
    payload: { method: 'setPump_Command', params: 'true' },
  })
  assert.equal(acceptedCommand.payload.params, true)
  assert.equal(acceptedResponse.topic, 'v1/devices/me/rpc/response/205')
  assert.deepEqual(acceptedResponse.payload, {
    ok: true,
    accepted: true,
    method: 'setPump_Command',
    value: true,
  })

  const [invalidCommand, invalidResponse] = validate({
    topic: 'v1/devices/me/rpc/request/206',
    payload: { method: 'setPump_Command', params: 'not-a-boolean' },
  })
  assert.equal(invalidCommand, null)
  assert.equal(invalidResponse.payload.accepted, false)
  assert.match(invalidResponse.payload.error, /Boolean params required/)

  const [unsupportedCommand, unsupportedResponse] = validate({
    topic: 'v1/devices/me/rpc/request/207',
    payload: { method: 'setValue', params: 50 },
  })
  assert.equal(unsupportedCommand, null)
  assert.equal(unsupportedResponse.payload.accepted, false)
  assert.match(unsupportedResponse.payload.error, /Unsupported RPC method/)
})

test('Node-RED returns correlated two-way responses for controls without readback', () => {
  const validator = flow.find(node => node.id === 'rpc-validator')
  const validate = new Function('msg', validator.func)
  const methods = ['setAuto_Mode', 'setManual_Mode', 'setReset']

  methods.forEach((method, index) => {
    const requestId = String(300 + index)
    const [command, response] = validate({
      topic: `v1/devices/me/rpc/request/${requestId}`,
      payload: { method, params: true },
    })
    assert.equal(command.payload.method, method)
    assert.equal(response.topic, `v1/devices/me/rpc/response/${requestId}`)
    assert.deepEqual(response.payload, { ok: true, accepted: true, method, value: true })
  })
})
