import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { IpcRuntimeEventSink, routeRuntimeControlMessage, runtimeControlMessage, runtimeIpcMessage, RUNTIME_CONTROL_TYPES, RUNTIME_IPC_TYPES } from '../server/connectors/runtime-ipc.js'
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
  const mirroredTelemetry = []
  const mirroredCommands = []
  const hub = {
    publish: event => telemetry.push(event),
    publishCommand: event => commands.push(event),
  }
  assert.equal(routeRuntimeIpcMessage({ type: RUNTIME_IPC_TYPES.telemetry }, hub), false)
  assert.equal(routeRuntimeIpcMessage(runtimeIpcMessage(RUNTIME_IPC_TYPES.telemetry, { events: [telemetryEvent(3)], dropped: 2 }), hub, { onTelemetryBatch: (events, dropped) => mirroredTelemetry.push({ events, dropped }) }), true)
  assert.equal(routeRuntimeIpcMessage(runtimeIpcMessage(RUNTIME_IPC_TYPES.command, { event: { requestId: 'request-2' } }), hub, { onCommandStatus: event => mirroredCommands.push(event) }), true)
  assert.equal(routeRuntimeIpcMessage(runtimeIpcMessage(RUNTIME_IPC_TYPES.health, { readiness: { ok: true } }), hub, { onHealth: value => health.push(value) }), true)
  assert.equal(telemetry[0].value, 3)
  assert.equal(commands[0].requestId, 'request-2')
  assert.equal(health[0].readiness.ok, true)
  assert.equal(mirroredTelemetry[0].events[0].value, 3)
  assert.equal(mirroredTelemetry[0].dropped, 2)
  assert.equal(mirroredCommands[0].requestId, 'request-2')

  assert.doesNotThrow(() => routeRuntimeIpcMessage(runtimeIpcMessage(RUNTIME_IPC_TYPES.telemetry, { events: [telemetryEvent(4)] }), hub, { onTelemetryBatch: () => { throw new Error('shadow failed') } }))
  assert.equal(telemetry.at(-1).value, 4)
})

test('worker control router accepts only versioned command wake messages and isolates callbacks', () => {
  let wakes = 0
  assert.equal(routeRuntimeControlMessage({ type: RUNTIME_CONTROL_TYPES.commandWake }, { onCommandWake: () => { wakes += 1 } }), false)
  assert.equal(routeRuntimeControlMessage(runtimeIpcMessage(RUNTIME_IPC_TYPES.command, {}), { onCommandWake: () => { wakes += 1 } }), false)
  assert.equal(routeRuntimeControlMessage(runtimeControlMessage(RUNTIME_CONTROL_TYPES.commandWake), { onCommandWake: () => { wakes += 1 } }), true)
  assert.equal(wakes, 1)
  assert.doesNotThrow(() => routeRuntimeControlMessage(runtimeControlMessage(RUNTIME_CONTROL_TYPES.commandWake), { onCommandWake: () => { throw new Error('scheduler stopped') } }))
})

test('managed worker reports readiness from a live private IPC heartbeat', async () => {
  const child = new EventEmitter()
  const kills = []
  const controlMessages = []
  child.connected = true
  child.send = (message, callback) => {
    controlMessages.push(message)
    callback?.(null)
    return true
  }
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
  assert.equal(worker.requestCommandPoll(), false)
  worker.start()
  assert.equal(worker.requestCommandPoll(), true)
  assert.equal(controlMessages[0].type, RUNTIME_CONTROL_TYPES.commandWake)
  assert.equal(routeRuntimeControlMessage(controlMessages[0], { onCommandWake: () => {} }), true)
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
  assert.equal(worker.requestCommandPoll(), false)
})

test('managed worker falls back safely on command wake backpressure or a closed IPC channel', async () => {
  const child = new EventEmitter()
  child.connected = true
  child.send = () => false
  child.kill = signal => {
    queueMicrotask(() => child.emit('exit', 0, signal))
    return true
  }
  const worker = new ManagedConnectorWorker({
    hub: { publish() {}, publishCommand() {} },
    forkImpl: () => child,
    logger: { log() {}, error() {} },
    shutdownTimeoutMs: 100,
  })
  worker.start()
  assert.equal(worker.requestCommandPoll(), false)
  child.send = () => { throw new Error('channel closed') }
  assert.doesNotThrow(() => worker.requestCommandPoll())
  assert.equal(worker.requestCommandPoll(), false)
  await worker.close()
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
