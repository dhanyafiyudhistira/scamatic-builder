export const RUNTIME_IPC_SOURCE = 'scamatic-data-plane'
export const RUNTIME_IPC_VERSION = 1
export const RUNTIME_CONTROL_SOURCE = 'scamatic-control-plane'
export const RUNTIME_CONTROL_VERSION = 1

export const RUNTIME_IPC_TYPES = Object.freeze({
  hello: 'runtime.worker.hello',
  health: 'runtime.worker.health',
  telemetry: 'runtime.telemetry.batch',
  command: 'runtime.command.status',
})

export const RUNTIME_CONTROL_TYPES = Object.freeze({
  commandWake: 'runtime.command.wake',
})

export function runtimeIpcMessage(type, payload = {}) {
  return {
    source: RUNTIME_IPC_SOURCE,
    version: RUNTIME_IPC_VERSION,
    type,
    ts: Date.now(),
    payload,
  }
}

export function runtimeControlMessage(type, payload = {}) {
  return {
    source: RUNTIME_CONTROL_SOURCE,
    version: RUNTIME_CONTROL_VERSION,
    type,
    ts: Date.now(),
    payload,
  }
}

export function isRuntimeIpcMessage(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.source === RUNTIME_IPC_SOURCE
    && message.version === RUNTIME_IPC_VERSION
    && Object.values(RUNTIME_IPC_TYPES).includes(message.type)
    && message.payload
    && typeof message.payload === 'object'
  )
}

export function isRuntimeControlMessage(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.source === RUNTIME_CONTROL_SOURCE
    && message.version === RUNTIME_CONTROL_VERSION
    && Object.values(RUNTIME_CONTROL_TYPES).includes(message.type)
    && message.payload
    && typeof message.payload === 'object'
  )
}

export function routeRuntimeControlMessage(message, { onCommandWake = () => {} } = {}) {
  if (!isRuntimeControlMessage(message)) return false
  if (message.type === RUNTIME_CONTROL_TYPES.commandWake) {
    try { onCommandWake() } catch {}
    return true
  }
  return false
}

export class IpcRuntimeEventSink {
  constructor({
    send = message => process.send?.(message),
    healthProvider = defaultHealth,
    flushMs = 25,
    heartbeatMs = 1_000,
    maxPending = 20_000,
  } = {}) {
    this.send = send
    this.healthProvider = healthProvider
    this.flushMs = positiveInteger(flushMs, 25)
    this.heartbeatMs = positiveInteger(heartbeatMs, 1_000)
    this.maxPending = positiveInteger(maxPending, 20_000)
    this.pending = new Map()
    this.flushTimer = null
    this.heartbeatTimer = null
    this.started = false
    this.dropped = 0
  }

  async ready() {
    if (this.started) return
    this.started = true
    this.#emit(RUNTIME_IPC_TYPES.hello, { pid: process.pid, capabilities: ['telemetry', 'command-status', 'health'] })
    this.#publishHealth()
    this.heartbeatTimer = setInterval(() => this.#publishHealth(), this.heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  publish(event) {
    if (!event?.workspaceId || !event?.projectId || !event?.tagId) return false
    const key = `${event.workspaceId}:${event.projectId}:${event.tagId}`
    if (!this.pending.has(key) && this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.pending.delete(oldest)
      this.dropped += 1
    }
    this.pending.set(key, event)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.#flush(), this.flushMs)
      this.flushTimer.unref?.()
    }
    return true
  }

  publishCommand(event) {
    if (!event?.requestId || !event?.componentId) return 0
    return this.#emit(RUNTIME_IPC_TYPES.command, { event }) ? 1 : 0
  }

  async close() {
    clearTimeout(this.flushTimer)
    clearInterval(this.heartbeatTimer)
    this.flushTimer = null
    this.heartbeatTimer = null
    this.#flush()
    this.started = false
  }

  #flush() {
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.pending.size) return
    const events = [...this.pending.values()]
    this.pending.clear()
    this.#emit(RUNTIME_IPC_TYPES.telemetry, { events, dropped: this.dropped })
    this.dropped = 0
  }

  #publishHealth() {
    this.#emit(RUNTIME_IPC_TYPES.health, {
      liveness: this.healthProvider('liveness'),
      readiness: this.healthProvider('readiness'),
    })
  }

  #emit(type, payload) {
    try {
      return this.send(runtimeIpcMessage(type, payload)) !== false
    } catch {
      return false
    }
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function defaultHealth(kind) {
  return { ok: kind === 'liveness', status: kind === 'liveness' ? 'alive' : 'not-ready' }
}
