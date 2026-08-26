import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  isRustShadowOutput,
  RustShadowWorker,
  rustShadowControlMessage,
  rustShadowEnvironment,
} from '../server/connectors/rust-shadow-worker.js'

test('Rust shadow worker mirrors coalesced telemetry and projected command status without secrets', async () => {
  const child = fakeChildProcess()
  const input = []
  let spawnOptions = null
  child.stdin.on('data', chunk => {
    input.push(String(chunk))
    if (String(chunk).includes('control.shutdown')) queueMicrotask(() => child.emit('exit', 0, null))
  })
  const worker = new RustShadowWorker({
    binaryPath: 'C:\\scamatic-data-plane.exe',
    binaryExists: () => true,
    spawnImpl: (binary, args, options) => {
      spawnOptions = options
      return child
    },
    environment: { PATH: 'safe-path', MONGO_URI: 'must-not-leak', SCADA_CONNECTOR_MASTER_KEY: 'must-not-leak' },
    flushMs: 1,
    logger: { log() {}, warn() {}, error() {} },
    shutdownTimeoutMs: 100,
  })

  assert.equal(worker.start(), true)
  assert.equal(spawnOptions.windowsHide, true)
  assert.equal(spawnOptions.env.PATH, 'safe-path')
  assert.equal(spawnOptions.env.MONGO_URI, undefined)
  assert.equal(spawnOptions.env.SCADA_CONNECTOR_MASTER_KEY, undefined)

  child.stdout.write(`${JSON.stringify(shadowOutput('shadow.worker.hello', { healthUrl: 'http://127.0.0.1:43123', active: false }))}\n`)
  child.stdout.write(`${JSON.stringify(shadowOutput('shadow.worker.health', { ok: true, status: 'ready', active: false, telemetryEvents: 0 }))}\n`)
  await immediate()
  assert.equal(worker.health().ok, true)
  assert.equal(worker.health().healthUrl, 'http://127.0.0.1:43123')

  worker.publishTelemetryBatch([telemetryEvent(1), telemetryEvent(2)], 3)
  worker.publishCommandStatus({
    requestId: 'request-1',
    componentId: 'button-1',
    tagId: 'tag-1',
    status: 'dispatched',
    payloadSummary: { token: 'must-not-leak' },
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  const frames = input.join('').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const telemetry = frames.find(frame => frame.type === 'shadow.telemetry.batch')
  const command = frames.find(frame => frame.type === 'shadow.command.status')
  assert.equal(telemetry.payload.events.length, 1)
  assert.equal(telemetry.payload.events[0].value, 2)
  assert.equal(telemetry.payload.dropped, 3)
  assert.equal(command.payload.event.requestId, 'request-1')
  assert.equal(JSON.stringify(command).includes('must-not-leak'), false)
  assert.equal(worker.publishCommandStatus({ requestId: 'request-bigint', componentId: 'button-1', status: 'acknowledged', resultSummary: { value: 1n } }), false)

  await worker.close()
  assert.equal(input.join('').includes('control.shutdown'), true)
  assert.deepEqual(child.kills, [])
})

test('Rust shadow protocol and environment reject foreign output and control-plane secrets', () => {
  assert.equal(isRustShadowOutput(shadowOutput('shadow.worker.health', { ok: true })), true)
  assert.equal(isRustShadowOutput({ ...shadowOutput('shadow.worker.health', {}), source: 'foreign' }), false)
  assert.equal(rustShadowControlMessage('control.ping').source, 'scamatic-control-plane')
  assert.deepEqual(rustShadowEnvironment({ PATH: 'safe', TEMP: 'temp', MONGO_URI: 'secret' }), { PATH: 'safe', TEMP: 'temp' })
})

function fakeChildProcess() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.kills = []
  child.kill = signal => {
    child.kills.push(signal)
    queueMicrotask(() => child.emit('exit', 0, signal))
    return true
  }
  return child
}

function shadowOutput(type, payload) {
  return {
    source: 'scamatic-rust-data-plane',
    version: 1,
    type,
    ts: Date.now(),
    payload,
  }
}

function telemetryEvent(value) {
  return {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    tagId: 'tag-1',
    value,
    receivedAt: new Date().toISOString(),
  }
}

function immediate() {
  return new Promise(resolve => setImmediate(resolve))
}
