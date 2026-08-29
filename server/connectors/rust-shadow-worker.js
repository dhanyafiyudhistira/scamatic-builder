import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeCommandProjection } from '../../shared/command-lifecycle.js'
import { isaacCanarySelected } from '../../shared/runtime-engine.js'

export const RUST_SHADOW_CONTROL_SOURCE = 'scamatic-control-plane'
export const RUST_SHADOW_OUTPUT_SOURCE = 'scamatic-rust-data-plane'
export const RUST_SHADOW_PROTOCOL_VERSION = 1

const OUTPUT_TYPES = new Set([
  'shadow.worker.hello',
  'shadow.worker.health',
  'shadow.worker.protocol-error',
  'shadow.worker.stopped',
])

export class RustShadowWorker {
  constructor({
    binaryPath = resolveRustShadowBinary(),
    binaryExists = existsSync,
    spawnImpl = spawn,
    environment = process.env,
    flushMs = 25,
    maxPending = 20_000,
    maxOutbound = 256,
    heartbeatTimeoutMs = 5_000,
    restartInitialMs = 1_000,
    restartMaximumMs = 30_000,
    shutdownTimeoutMs = 5_000,
    logger = console,
  } = {}) {
    this.binaryPath = binaryPath
    this.binaryExists = binaryExists
    this.spawnImpl = spawnImpl
    this.environment = environment
    this.flushMs = positiveInteger(flushMs, 25)
    this.maxPending = positiveInteger(maxPending, 20_000)
    this.maxOutbound = positiveInteger(maxOutbound, 256)
    this.heartbeatTimeoutMs = positiveInteger(heartbeatTimeoutMs, 5_000)
    this.restartInitialMs = positiveInteger(restartInitialMs, 1_000)
    this.restartMaximumMs = Math.max(this.restartInitialMs, positiveInteger(restartMaximumMs, 30_000))
    this.shutdownTimeoutMs = positiveInteger(shutdownTimeoutMs, 5_000)
    this.logger = logger
    this.child = null
    this.reader = null
    this.pending = new Map()
    this.pendingDropped = 0
    this.outbound = []
    this.backpressured = false
    this.flushTimer = null
    this.restartTimer = null
    this.restartAttempts = 0
    this.lastHealth = null
    this.lastHeartbeatAt = 0
    this.healthUrl = null
    this.unavailableReason = null
    this.stopping = false
  }

  start() {
    if (this.child || this.stopping) return Boolean(this.child)
    if (!this.binaryExists(this.binaryPath)) {
      this.unavailableReason = 'binary-not-found'
      const warn = this.logger.warn || this.logger.log
      warn.call(this.logger, '[RustShadow] Binary not found; active Node data-plane remains unchanged.', { binary: this.binaryPath })
      return false
    }
    this.unavailableReason = null
    this.#spawn()
    return true
  }

  publishTelemetryBatch(events, upstreamDropped = 0) {
    if (!this.child || !Array.isArray(events)) return false
    for (const event of events) {
      if (!event?.workspaceId || !event?.projectId || !event?.tagId) continue
      const key = `${event.workspaceId}:${event.projectId}:${event.tagId}`
      if (!this.pending.has(key) && this.pending.size >= this.maxPending) {
        const oldest = this.pending.keys().next().value
        if (oldest !== undefined) this.pending.delete(oldest)
        this.pendingDropped += 1
      }
      this.pending.set(key, event)
    }
    this.pendingDropped += nonNegativeInteger(upstreamDropped, 0)
    if (this.pending.size && !this.flushTimer) {
      this.flushTimer = setTimeout(() => this.#flushTelemetry(), this.flushMs)
      this.flushTimer.unref?.()
    }
    return true
  }

  publishCommandStatus(event) {
    if (!this.child) return false
    const command = runtimeCommandProjection(event)
    if (!command.requestId || !command.componentId) return false
    return this.#enqueue('shadow.command.status', {
      event: command,
      scope: {
        userId: String(event?.actorId || ''),
        workspaceId: String(event?.workspaceId || ''),
        projectId: String(event?.projectId || ''),
        versionId: String(event?.versionId || ''),
      },
    }, 'command')
  }

  canary(project) {
    if (!isaacCanaryProjectAllowed(project, this.environment)) return null
    const url = resolveIsaacStreamPublicUrl(this.environment)
    const health = this.health()
    if (!url || !health.ok || health.gatewayReady !== true) return null
    return { url }
  }

  health() {
    const heartbeatAgeMs = this.lastHeartbeatAt ? Date.now() - this.lastHeartbeatAt : null
    const responsive = Boolean(this.child && heartbeatAgeMs != null && heartbeatAgeMs <= this.heartbeatTimeoutMs)
    const ready = responsive && this.lastHealth?.ok === true
    return {
      ...(this.lastHealth || {}),
      ok: ready,
      status: ready ? 'ready' : this.unavailableReason || (this.child ? responsive ? 'starting' : 'unresponsive' : this.stopping ? 'stopping' : 'stopped'),
      mode: this.lastHealth?.gatewayReady ? 'rust-isaac-canary' : 'rust-shadow',
      active: this.lastHealth?.gatewayReady === true,
      heartbeatAgeMs,
      healthUrl: this.healthUrl,
      binaryAvailable: !this.unavailableReason,
      queue: { telemetry: this.pending.size, outbound: this.outbound.length, dropped: this.pendingDropped },
    }
  }

  async close() {
    this.stopping = true
    clearTimeout(this.flushTimer)
    clearTimeout(this.restartTimer)
    this.flushTimer = null
    this.restartTimer = null
    this.#flushTelemetry()
    const child = this.child
    if (!child) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    this.#writeImmediately(rustShadowControlMessage('control.shutdown'))
    await Promise.race([exited, delay(this.shutdownTimeoutMs)])
    if (this.child === child) {
      child.kill('SIGTERM')
      await Promise.race([exited, delay(1_000)])
    }
    if (this.child === child) child.kill('SIGKILL')
  }

  #spawn() {
    let child
    try {
      child = this.spawnImpl(this.binaryPath, [], {
        cwd: dirname(this.binaryPath),
        env: rustShadowEnvironment(this.environment),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'inherit'],
      })
    } catch (error) {
      this.unavailableReason = 'spawn-failed'
      this.logger.error('[RustShadow] Could not start shadow worker.', { code: safeErrorCode(error) })
      return
    }
    this.child = child
    this.lastHealth = null
    this.lastHeartbeatAt = 0
    this.healthUrl = null
    this.backpressured = false
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.reader.on('line', line => this.#handleOutputLine(line))
    child.stdin.on('error', error => {
      if (!this.stopping) this.logger.error('[RustShadow] IPC input failed.', { code: safeErrorCode(error) })
    })
    child.once('error', error => {
      this.logger.error('[RustShadow] Process failed.', { code: safeErrorCode(error) })
    })
    child.once('exit', (code, signal) => this.#handleExit(child, code, signal))
    this.logger.log('[RustShadow] Rust/Tokio shadow worker starting over private NDJSON IPC.')
    this.#enqueue('control.ping', {}, 'control')
  }

  #handleOutputLine(line) {
    if (Buffer.byteLength(line) > 1_048_576) return
    let message
    try { message = JSON.parse(line) } catch { return }
    if (!isRustShadowOutput(message)) return
    if (message.type === 'shadow.worker.hello') {
      this.healthUrl = safeLoopbackHealthUrl(message.payload.healthUrl)
      return
    }
    if (message.type === 'shadow.worker.health') {
      this.lastHealth = message.payload
      this.lastHeartbeatAt = Date.now()
      if (message.payload.ok === true) this.restartAttempts = 0
      return
    }
    if (message.type === 'shadow.worker.protocol-error') {
      this.logger.error('[RustShadow] Control-plane frame rejected.', { code: String(message.payload.code || 'PROTOCOL_ERROR').slice(0, 80) })
    }
  }

  #flushTelemetry() {
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.pending.size) return
    const events = [...this.pending.values()]
    const dropped = this.pendingDropped
    this.pending.clear()
    this.pendingDropped = 0
    this.#enqueue('shadow.telemetry.batch', { events, dropped }, 'telemetry')
  }

  #enqueue(type, payload, kind) {
    if (!this.child?.stdin?.writable) return false
    if (this.outbound.length >= this.maxOutbound) {
      const telemetryIndex = this.outbound.findIndex(item => item.kind === 'telemetry')
      if (telemetryIndex >= 0) this.outbound.splice(telemetryIndex, 1)
      else return false
    }
    let line
    try { line = `${JSON.stringify(rustShadowControlMessage(type, payload))}\n` } catch { return false }
    this.outbound.push({ kind, line })
    this.#drainOutbound()
    return true
  }

  #drainOutbound() {
    const input = this.child?.stdin
    if (!input?.writable || this.backpressured) return
    while (this.outbound.length) {
      const item = this.outbound.shift()
      if (input.write(item.line) !== false) continue
      this.backpressured = true
      input.once('drain', () => {
        this.backpressured = false
        this.#drainOutbound()
      })
      break
    }
  }

  #writeImmediately(message) {
    try {
      if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      // The process may already be exiting; the timeout path terminates it.
    }
  }

  #handleExit(child, code, signal) {
    if (this.child !== child) return
    this.reader?.close()
    this.reader = null
    this.child = null
    this.lastHealth = null
    this.lastHeartbeatAt = 0
    this.healthUrl = null
    this.outbound = []
    this.pending.clear()
    this.pendingDropped = 0
    if (this.stopping) return
    const delayMs = Math.min(this.restartMaximumMs, this.restartInitialMs * (2 ** this.restartAttempts))
    this.restartAttempts += 1
    this.logger.error('[RustShadow] Worker stopped; shadow restart scheduled.', { code, signal, delayMs })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.#spawn()
    }, delayMs)
    this.restartTimer.unref?.()
  }
}

export function rustShadowControlMessage(type, payload = {}) {
  return {
    source: RUST_SHADOW_CONTROL_SOURCE,
    version: RUST_SHADOW_PROTOCOL_VERSION,
    type,
    ts: Date.now(),
    payload,
  }
}

export function isRustShadowOutput(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.source === RUST_SHADOW_OUTPUT_SOURCE
    && message.version === RUST_SHADOW_PROTOCOL_VERSION
    && OUTPUT_TYPES.has(message.type)
    && message.payload
    && typeof message.payload === 'object'
  )
}

export function resolveRustShadowBinary(env = process.env, platform = process.platform) {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const configured = String(env.SCADA_RUST_SHADOW_BINARY || '').trim()
  if (configured) return isAbsolute(configured) ? configured : resolve(projectRoot, configured)
  const binary = platform === 'win32' ? 'scamatic-data-plane.exe' : 'scamatic-data-plane'
  const release = join(projectRoot, 'data-plane-rs', 'target', 'release', binary)
  const debug = join(projectRoot, 'data-plane-rs', 'target', 'debug', binary)
  return existsSync(release) ? release : existsSync(debug) ? debug : release
}

export function rustShadowEnvironment(env = process.env) {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'RUST_BACKTRACE',
    'SCADA_ISAAC_GATEWAY_ENABLED', 'SCADA_ISAAC_STREAM_BIND', 'SCADA_ISAAC_INTERNAL_HOST', 'SCADA_ISAAC_INTERNAL_PORT',
    'SCADA_ISAAC_INTERNAL_TOKEN', 'SCADA_ISAAC_ALLOWED_ORIGINS', 'SCADA_ISAAC_REVALIDATE_MS',
  ]
  return Object.fromEntries(allowed.filter(name => env[name] != null).map(name => [name, env[name]]))
}

export function isaacCanaryProjectAllowed(project, env = process.env) {
  if (env.SCADA_ISAAC_CANARY_ENABLED !== 'true') return false
  return isaacCanarySelected(project)
}

export function resolveIsaacStreamPublicUrl(env = process.env) {
  const configured = String(env.SCADA_ISAAC_STREAM_PUBLIC_URL || '').trim()
  if (!configured) return null
  let url
  try { url = new URL(configured) } catch { return null }
  const validProtocol = env.NODE_ENV === 'production' ? url.protocol === 'wss:' : ['ws:', 'wss:'].includes(url.protocol)
  if (!validProtocol || url.username || url.password || url.search || url.hash) return null
  if (url.pathname === '/') url.pathname = '/isaac-stream'
  if (url.pathname !== '/isaac-stream') return null
  return url.toString()
}

function safeLoopbackHealthUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash
      ? url.toString().replace(/\/$/, '')
      : null
  } catch {
    return null
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function safeErrorCode(error) {
  return String(error?.code || error?.name || 'RUST_SHADOW_FAILED').slice(0, 80)
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
