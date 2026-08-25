import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { IpcRuntimeEventSink, runtimeIpcMessage, RUNTIME_IPC_TYPES } from '../server/connectors/runtime-ipc.js'
import { ManagedConnectorWorker, routeRuntimeIpcMessage } from '../server/connectors/managed-connector-worker.js'

test('IPC event sink coalesces telemetry and keeps command status on the immediate path', async () => {
  const messages = []
  const sink = new IpcRuntimeEventSink({
    send: message => { messages.push(message); return true },
    flushMs: 1,
    heartbeatMs: 60_000,
    healthProvider: kind => ({ ok: true, status: kind === 'liveness' ? 'alive' : 'ready' }),
  })
  await sink.ready()
  sink.publish(telemetryEvent(1))
  sink.publish(telemetryEvent(2))
  assert.equal(sink.publishCommand({ requestId: 'request-1', componentId: 'button-1', status: 'dispatched' }), 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  await sink.close()

  assert.equal(messages[0].type, RUNTIME_IPC_TYPES.hello)
  assert.equal(messages[1].type, RUNTIME_IPC_TYPES.health)
  assert.equal(messages.find(message => message.type === RUNTIME_IPC_TYPES.command).payload.event.status, 'dispatched')
  const telemetry = messages.find(message => message.type === RUNTIME_IPC_TYPES.telemetry)
  assert.equal(telemetry.payload.events.length, 1)
  assert.equal(telemetry.payload.events[0].value, 2)
})

test('managed worker IPC router rejects foreign frames and forwards valid batches', () => {
  const telemetry = []
  const commands = []
  const health = []
  const hub = {
    publish: event => telemetry.push(event),
    publishCommand: event => commands.push(event),
  }
  assert.equal(routeRuntimeIpcMessage({ type: RUNTIME_IPC_TYPES.telemetry }, hub), false)
  assert.equal(routeRuntimeIpcMessage(runtimeIpcMessage(RUNTIME_IPC_TYPES.telemetry, { events: [telemetryEvent(3)] }), hub), true)
  assert.equal(routeRuntimeIpcMessage(runtimeIpcMessage(RUNTIME_IPC_TYPES.command, { event: { requestId: 'request-2' } }), hub), true)
  assert.equal(routeRuntimeIpcMessage(runtimeIpcMessage(RUNTIME_IPC_TYPES.health, { readiness: { ok: true } }), hub, { onHealth: value => health.push(value) }), true)
  assert.equal(telemetry[0].value, 3)
  assert.equal(commands[0].requestId, 'request-2')
  assert.equal(health[0].readiness.ok, true)
})

test('managed worker reports readiness from a live private IPC heartbeat', async () => {
  const child = new EventEmitter()
  const kills = []
  child.kill = signal => {
    kills.push(signal)
    queueMicrotask(() => child.emit('exit', 0, signal))
    return true
  }
  const worker = new ManagedConnectorWorker({
    hub: { publish() {}, publishCommand() {} },
    forkImpl: (entrypoint, args, options) => {
      assert.equal(options.env.CONNECTOR_STREAM_TRANSPORT, 'ipc')
      assert.deepEqual(options.stdio, ['ignore', 'inherit', 'inherit', 'ipc'])
      return child
    },
    logger: { log() {}, error() {} },
    shutdownTimeoutMs: 100,
  })
  worker.start()
  assert.equal(worker.health('readiness').ok, false)
  worker.restartAttempts = 2
  child.emit('message', runtimeIpcMessage(RUNTIME_IPC_TYPES.health, {
    liveness: { ok: true, status: 'alive' },
    readiness: { ok: false, status: 'not-ready', checks: { mongo: 'connecting' } },
  }))
  assert.equal(worker.restartAttempts, 2)
  child.emit('message', runtimeIpcMessage(RUNTIME_IPC_TYPES.health, {
    liveness: { ok: true, status: 'alive' },
    readiness: { ok: true, status: 'ready', checks: { mongo: 'connected' } },
  }))
  assert.equal(worker.restartAttempts, 0)
  assert.equal(worker.health('readiness').ok, true)
  assert.equal(worker.health('readiness').checks.worker, 'connected')
  await worker.close()
  assert.deepEqual(kills, ['SIGTERM'])
})

function telemetryEvent(value) {
  return {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    tagId: 'tag-1',
    value,
    sourceTimestamp: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  }
}
