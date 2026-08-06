import assert from 'node:assert/strict'
import { ThingsBoardDriver } from '../server/connectors/thingsboard-driver.js'

const serverUrl = process.env.THINGSBOARD_SIMULATOR_URL || 'http://127.0.0.1:8090'
const token = process.env.THINGSBOARD_SIMULATOR_TOKEN || 'staging-simulator-token-change-me'
const deviceId = process.env.THINGSBOARD_SIMULATOR_DEVICE_ID || '00000000-0000-0000-0000-000000000001'
const driver = new ThingsBoardDriver()

try {
  const auth = await fetch(`${serverUrl}/api/auth/user`, { headers: { 'X-Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(3000) })
  assert.equal(auth.status, 200, 'Simulator credential test must succeed.')
  const rejectedAuth = await fetch(`${serverUrl}/api/auth/user`, { headers: { 'X-Authorization': 'Bearer deliberately-invalid-token' }, signal: AbortSignal.timeout(3000) })
  assert.equal(rejectedAuth.status, 401, 'Simulator must reject an invalid credential.')

  await driver.connect({ config: { serverUrl, deviceId, rpcMode: 'two-way' }, secret: { jwt: token } })
  const subscription = driver.subscribe([
    { id: 'level', path: 'Level_mix', dataType: 'number' },
    { id: 'feedback', path: 'command_feedback', dataType: 'number' },
  ])
  const sample = await Promise.race([
    subscription.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Simulator telemetry timed out.')), 4000)),
  ])
  assert.equal(sample.done, false)
  assert.ok(['Level_mix', 'command_feedback'].includes(sample.value.path))

  const receipt = await driver.write({ method: 'setLevel', params: 55, timeoutMs: 3000, acknowledgment: { mode: 'two-way' } })
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.acknowledged, true)
  assert.equal(receipt.result?.value, 55)

  const oneWayReceipt = await driver.write({ method: 'setLevel', params: 60, timeoutMs: 3000, acknowledgment: { mode: 'feedback-tag' } })
  assert.equal(oneWayReceipt.accepted, true)
  assert.equal(oneWayReceipt.acknowledged, false, 'One-way HTTP success must not be treated as a device acknowledgment.')

  console.log(JSON.stringify({ ok: true, auth: 'accepted-and-invalid-rejected', telemetry: 'received', twoWayRpc: 'acknowledged', oneWayRpc: 'accepted-not-acknowledged' }))
} finally {
  await driver.disconnect()
}
