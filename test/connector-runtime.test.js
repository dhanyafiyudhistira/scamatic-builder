import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncQueue } from '../server/connectors/async-queue.js'
import { ConnectorRuntime } from '../server/connectors/connector-runtime.js'

const connector = { id: 'connector-a', workspaceId: 'workspace-a', projectId: 'project-a' }
const environment = { config: { commandTimeoutMs: 1000 }, secret: { jwt: 'not-used-by-fake' } }
const source = { id: 'source-a', type: 'thingsboard' }
const bindings = [
  { id: 'level', path: 'Level_mix', dataType: 'number', freshnessMode: 'periodic', adaptiveFreshness: false, staleAfterMs: 1000 },
  { id: 'feedback', path: 'command_feedback', dataType: 'number', freshnessMode: 'periodic', adaptiveFreshness: false, staleAfterMs: 1000 },
]

test('connector runtime transitions good to stale/disconnected and recovers without losing the last value', async () => {
  let now = Date.parse('2026-07-22T00:00:00.000Z')
  const driver = new ControlledDriver()
  const events = []
  const runtime = new ConnectorRuntime({ connector, environment, source, bindings, driverFactory: () => driver, onEvent: async event => events.push(event), onHealth: async () => {}, now: () => now })
  runtime.start()
  await waitUntil(() => driver.connected)
  driver.queue.push({ path: 'Level_mix', value: '42.5', sourceTimestamp: new Date(now).toISOString() })
  await waitUntil(() => events.some(event => event.tagId === 'level' && event.quality === 'good'))

  now += 1500
  await waitUntil(() => events.some(event => event.tagId === 'level' && event.quality === 'stale'), 2500)
  const stale = events.find(event => event.tagId === 'level' && event.quality === 'stale')
  assert.equal(stale.value, 42.5)

  now += 2500
  await waitUntil(() => events.some(event => event.tagId === 'level' && event.quality === 'disconnected'), 2500)
  const disconnected = events.find(event => event.tagId === 'level' && event.quality === 'disconnected')
  assert.equal(disconnected.value, 42.5)

  driver.queue.push({ path: 'Level_mix', value: '43.5', sourceTimestamp: new Date(now).toISOString() })
  await waitUntil(() => events.some(event => event.tagId === 'level' && event.quality === 'good' && event.value === 43.5))
  const sequences = events.filter(event => event.tagId === 'level').map(event => event.sequence)
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right))
  assert.equal(new Set(sequences).size, sequences.length)
  await runtime.stop()
})

test('feedback acknowledgment resolves only for the configured expected value and otherwise times out', async () => {
  let now = Date.parse('2026-07-22T00:00:00.000Z')
  const driver = new ControlledDriver()
  const accepted = []
  const runtime = new ConnectorRuntime({ connector, environment, source, bindings, driverFactory: () => driver, onEvent: async () => {}, onHealth: async () => {}, now: () => now })
  runtime.start()
  await waitUntil(() => driver.connected)

  const acknowledged = runtime.write({ method: 'setLevel', params: 55, timeoutMs: 800, acknowledgment: { mode: 'feedback-tag', tagId: 'feedback', expectedValue: 55 } }, receipt => accepted.push(receipt.code))
  await waitUntil(() => accepted.length === 1)
  driver.queue.push({ path: 'command_feedback', value: '55', sourceTimestamp: new Date(now).toISOString() })
  assert.deepEqual(await acknowledged, { accepted: true, acknowledged: true, code: 'FEEDBACK_ACK' })

  const timedOut = runtime.write({ method: 'setLevel', params: 60, timeoutMs: 150, acknowledgment: { mode: 'feedback-tag', tagId: 'feedback', expectedValue: 60 } })
  driver.queue.push({ path: 'command_feedback', value: '59', sourceTimestamp: new Date(now).toISOString() })
  assert.deepEqual(await timedOut, { accepted: true, acknowledged: false, code: 'FEEDBACK_TIMEOUT' })
  await runtime.stop()
})

test('feedback waiter is armed before a fast process update and a slow gateway callback', async () => {
  const now = Date.parse('2026-07-22T00:00:00.000Z')
  const driver = new ControlledDriver()
  const events = []
  let releaseGatewayCallback
  const gatewayCallback = new Promise(resolve => { releaseGatewayCallback = resolve })
  driver.onWrite = () => driver.queue.push({ path: 'command_feedback', value: '77', sourceTimestamp: new Date(now).toISOString() })
  const runtime = new ConnectorRuntime({ connector, environment, source, bindings, driverFactory: () => driver, onEvent: async event => events.push(event), onHealth: async () => {}, now: () => now })
  runtime.start()
  await waitUntil(() => driver.connected)

  const completion = runtime.write(
    { method: 'setLevel', params: 77, timeoutMs: 500, acknowledgment: { mode: 'feedback-tag', tagId: 'feedback', expectedValue: 77 } },
    () => gatewayCallback,
  )
  await waitUntil(() => events.some(event => event.tagId === 'feedback' && event.value === 77))
  releaseGatewayCallback()

  assert.deepEqual(await completion, { accepted: true, acknowledged: true, code: 'FEEDBACK_ACK' })
  await runtime.stop()
})

test('terminal two-way receipts bypass the gateway-progress callback', async () => {
  const driver = new ControlledDriver()
  driver.receipt = { accepted: true, acknowledged: true, code: 'TWO_WAY_RPC_ACK', result: { ok: true } }
  let progressCallbacks = 0
  const runtime = new ConnectorRuntime({ connector, environment, source, bindings, driverFactory: () => driver, onEvent: async () => {}, onHealth: async () => {} })
  runtime.start()
  await waitUntil(() => driver.connected)

  const receipt = await runtime.write(
    { method: 'setLevel', params: 88, timeoutMs: 500, acknowledgment: { mode: 'two-way' } },
    () => { progressCallbacks += 1 },
  )

  assert.equal(progressCallbacks, 0)
  assert.deepEqual(receipt, driver.receipt)
  await runtime.stop()
})

test('event-driven tags stay good while the connector is online and quiet', async () => {
  let now = Date.parse('2026-07-22T00:00:00.000Z')
  const driver = new ControlledDriver()
  const events = []
  const eventBindings = [{ id: 'valve', path: 'Valve_106', dataType: 'boolean', freshnessMode: 'event-driven', adaptiveFreshness: false, staleAfterMs: 1000 }]
  const runtime = new ConnectorRuntime({ connector, environment, source, bindings: eventBindings, driverFactory: () => driver, onEvent: async event => events.push(event), onHealth: async () => {}, now: () => now })
  runtime.start()
  await waitUntil(() => driver.connected)
  driver.queue.push({ path: 'Valve_106', value: 'true', sourceTimestamp: new Date(now).toISOString() })
  await waitUntil(() => events.some(event => event.tagId === 'valve' && event.quality === 'good'))

  now += 30_000
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(events.some(event => event.tagId === 'valve' && event.quality !== 'good'), false)

  driver.queue.close(new Error('Synthetic disconnect.'))
  await waitUntil(() => events.some(event => event.tagId === 'valve' && event.quality === 'disconnected'))
  await runtime.stop()
})

test('connector runtime reconnects after an initial upstream failure', async () => {
  let attempts = 0
  const health = []
  const stableDriver = new ControlledDriver()
  const runtime = new ConnectorRuntime({
    connector, environment, source, bindings,
    driverFactory: () => attempts++ === 0 ? new FailingDriver() : stableDriver,
    onEvent: async () => {},
    onHealth: async (state, message) => health.push({ state, message }),
  })
  runtime.start()
  await waitUntil(() => stableDriver.connected, 2000)
  assert.ok(health.some(item => item.state === 'offline'))
  assert.ok(health.filter(item => item.state === 'connecting').length >= 2)
  assert.equal(health.at(-1).state, 'online')
  await runtime.stop()
})

class ControlledDriver {
  constructor() {
    this.queue = new AsyncQueue()
    this.connected = false
    this.onWrite = null
    this.receipt = { accepted: true, acknowledged: false, code: 'ACCEPTED_BY_GATEWAY' }
  }
  async connect() { this.connected = true }
  subscribe() { return this.queue }
  async write(request) { this.onWrite?.(request); return this.receipt }
  async disconnect() { this.queue.close(); this.connected = false }
}

class FailingDriver {
  async connect() { throw new Error('Synthetic upstream failure.') }
  async disconnect() {}
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true before timeout.')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
