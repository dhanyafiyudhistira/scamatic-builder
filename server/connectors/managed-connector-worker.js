import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isRuntimeIpcMessage, runtimeControlMessage, RUNTIME_CONTROL_TYPES, RUNTIME_IPC_TYPES } from './runtime-ipc.js'

const DEFAULT_ENTRYPOINT = fileURLToPath(new URL('../connector-worker.js', import.meta.url))

export class ManagedConnectorWorker {
  constructor({
    hub,
    observer = null,
    entrypoint = DEFAULT_ENTRYPOINT,
    forkImpl = fork,
    environment = process.env,
    heartbeatTimeoutMs = 5_000,
    restartInitialMs = 500,
    restartMaximumMs = 30_000,
    shutdownTimeoutMs = 40_000,
    logger = console,
  } = {}) {
    if (!hub) throw new Error('Managed connector worker requires a runtime stream hub.')
    this.hub = hub
    this.observer = observer
    this.entrypoint = entrypoint
    this.forkImpl = forkImpl
    this.environment = environment
    this.heartbeatTimeoutMs = positiveInteger(heartbeatTimeoutMs, 5_000)
    this.restartInitialMs = positiveInteger(restartInitialMs, 500)
    this.restartMaximumMs = Math.max(this.restartInitialMs, positiveInteger(restartMaximumMs, 30_000))
    this.shutdownTimeoutMs = positiveInteger(shutdownTimeoutMs, 40_000)
    this.logger = logger
    this.child = null
    this.restartTimer = null
    this.restartAttempts = 0
    this.lastHealth = null
    this.lastHeartbeatAt = 0
    this.stopping = false
  }

  start() {
    if (this.child || this.stopping) return this.child
    return this.#spawn()
  }

  health(kind = 'readiness') {
    const heartbeatAgeMs = this.lastHeartbeatAt ? Date.now() - this.lastHeartbeatAt : null
    const responsive = Boolean(this.child && heartbeatAgeMs != null && heartbeatAgeMs <= this.heartbeatTimeoutMs)
    if (kind === 'liveness') {
      return {
        ok: true,
        status: 'alive',
        mode: 'node-ipc',
        checks: { worker: this.child ? responsive ? 'running' : 'starting' : this.stopping ? 'stopping' : 'restarting' },
      }
    }
    const workerReadiness = this.lastHealth?.readiness
    const ready = responsive && workerReadiness?.ok === true
    return {
      ...(workerReadiness || {}),
      ok: ready,
      status: ready ? 'ready' : 'not-ready',
      mode: 'node-ipc',
      heartbeatAgeMs,
      checks: {
        ...(workerReadiness?.checks || {}),
        worker: responsive ? 'connected' : this.child ? 'unresponsive' : this.stopping ? 'stopping' : 'restarting',
      },
    }
  }

  requestCommandPoll() {
    return this.#sendControl(RUNTIME_CONTROL_TYPES.commandWake)
  }

  requestReload() {
    return this.#sendControl(RUNTIME_CONTROL_TYPES.workerReload)
  }

  #sendControl(type) {
    const child = this.child
    if (this.stopping || !child || child.connected === false || typeof child.send !== 'function') return false
    try {
      return child.send(runtimeControlMessage(type), () => {}) !== false
    } catch {
      // The durable polling path remains authoritative if IPC is unavailable.
      return false
    }
  }

  async close() {
    this.stopping = true
    clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    if (!child) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([exited, delay(this.shutdownTimeoutMs)])
    if (this.child === child) child.kill('SIGKILL')
  }

  #spawn() {
    const child = this.forkImpl(this.entrypoint, [], {
      env: { ...this.environment, CONNECTOR_STREAM_TRANSPORT: 'ipc' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    this.child = child
    this.lastHealth = null
    this.lastHeartbeatAt = 0
    child.on('message', message => {
      routeRuntimeIpcMessage(message, this.hub, {
        onHealth: health => {
          this.lastHealth = health
          this.lastHeartbeatAt = Date.now()
          if (health?.readiness?.ok === true) this.restartAttempts = 0
        },
        onTelemetryBatch: (events, dropped) => this.observer?.publishTelemetryBatch?.(events, dropped),
        onCommandStatus: event => this.observer?.publishCommandStatus?.(event),
      })
    })
    child.once('error', error => {
      this.logger.error('[DataPlane] Managed connector worker failed', { code: String(error?.code || error?.name || 'WORKER_FAILED').slice(0, 80) })
    })
    child.once('exit', (code, signal) => this.#handleExit(child, code, signal))
    this.logger.log('[DataPlane] Managed Node connector worker starting over private IPC.')
    return child
  }

  #handleExit(child, code, signal) {
    if (this.child !== child) return
    this.child = null
    this.lastHealth = null
    this.lastHeartbeatAt = 0
    if (this.stopping) return
    const delayMs = Math.min(this.restartMaximumMs, this.restartInitialMs * (2 ** this.restartAttempts))
    this.restartAttempts += 1
    this.logger.error('[DataPlane] Managed connector worker stopped; restart scheduled.', { code, signal, delayMs })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.#spawn()
    }, delayMs)
    this.restartTimer.unref?.()
  }
}

export function routeRuntimeIpcMessage(message, hub, { onHello = () => {}, onHealth = () => {}, onTelemetryBatch = () => {}, onCommandStatus = () => {} } = {}) {
  if (!isRuntimeIpcMessage(message)) return false
  if (message.type === RUNTIME_IPC_TYPES.hello) {
    onHello(message.payload)
    return true
  }
  if (message.type === RUNTIME_IPC_TYPES.health) {
    onHealth(message.payload)
    return true
  }
  if (message.type === RUNTIME_IPC_TYPES.telemetry) {
    const events = Array.isArray(message.payload.events) ? message.payload.events.slice(0, 20_000) : []
    for (const event of events) if (event && typeof event === 'object') hub.publish(event)
    safelyNotify(onTelemetryBatch, events, message.payload.dropped)
    return true
  }
  if (message.type === RUNTIME_IPC_TYPES.command) {
    if (message.payload.event && typeof message.payload.event === 'object') {
      hub.publishCommand(message.payload.event)
      safelyNotify(onCommandStatus, message.payload.event)
    }
    return true
  }
  return false
}

function safelyNotify(callback, ...values) {
  try { callback(...values) } catch {
    // Shadow observers are intentionally best-effort and cannot fail the
    // active WebSocket or RPC status path.
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
