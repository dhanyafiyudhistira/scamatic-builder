import { AsyncQueue } from './async-queue.js'
import WebSocket from 'ws'
import { assertSafeConnectorTarget } from '../../api/_lib/connector-target.js'

export class ThingsBoardDriver {
  constructor({ WebSocketImpl = WebSocket, fetchImpl = globalThis.fetch, validateTarget = assertSafeConnectorTarget } = {}) {
    this.WebSocketImpl = WebSocketImpl
    this.fetchImpl = fetchImpl
    this.validateTarget = validateTarget
    this.socket = null
    this.queue = null
    this.context = null
    this.bindings = []
    this.commandId = 1
    this.lastError = null
  }

  async connect(context) {
    if (!this.WebSocketImpl) throw new Error('A WebSocket implementation is required.')
    this.context = context
    const serverUrl = await this.validateTarget(context.config.serverUrl)
    const wsBase = serverUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
    const url = `${wsBase}/api/ws/plugins/telemetry?token=${encodeURIComponent(context.secret.jwt)}`
    await new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(url)
      this.socket = socket
      const timeout = setTimeout(() => { socket.close(); reject(new Error('ThingsBoard WebSocket connection timed out.')) }, 10_000)
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('ThingsBoard WebSocket connection failed.')) }, { once: true })
    })
  }

  subscribe(bindings) {
    if (!this.socket) throw new Error('Driver is not connected.')
    this.bindings = [...bindings]
    this.queue = new AsyncQueue()
    const socket = this.socket
    socket.addEventListener('message', event => this.#onMessage(event.data))
    socket.addEventListener('close', () => this.queue.close(new Error('ThingsBoard WebSocket disconnected.')), { once: true })
    socket.addEventListener('error', () => this.queue.close(new Error('ThingsBoard WebSocket failed.')), { once: true })
    socket.send(JSON.stringify({
      tsSubCmds: [{ entityType: 'DEVICE', entityId: this.context.config.deviceId, scope: 'LATEST_TELEMETRY', keys: bindings.map(item => item.path).join(','), cmdId: this.commandId++ }],
      historyCmds: [],
      attrSubCmds: [],
    }))
    return this.queue
  }

  async write(request) {
    const serverUrl = await this.validateTarget(this.context.config.serverUrl)
    const mode = request.acknowledgment?.mode || this.context.config.rpcMode
    const path = mode === 'two-way' ? 'twoway' : 'oneway'
    const response = await this.fetchImpl(`${serverUrl}/api/plugins/rpc/${path}/${this.context.config.deviceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Authorization': `Bearer ${this.context.secret.jwt}` },
      body: JSON.stringify({ method: request.method, params: request.params, timeout: request.timeoutMs, retries: 0 }),
      redirect: 'manual',
      signal: AbortSignal.timeout(request.timeoutMs),
    })
    if (!response.ok) return { accepted: false, acknowledged: false, code: `HTTP_${response.status}` }
    if (mode !== 'two-way') return { accepted: true, acknowledged: false, code: 'ACCEPTED_BY_GATEWAY' }
    const result = await response.json().catch(() => null)
    if (result?.accepted === false || result?.ok === false) {
      return { accepted: true, acknowledged: false, rejected: true, code: 'DEVICE_RPC_REJECTED', result }
    }
    return { accepted: true, acknowledged: true, code: 'TWO_WAY_RPC_ACK', result }
  }

  async health() {
    return { state: this.socket?.readyState === 1 ? 'online' : 'offline', message: this.lastError?.message || '' }
  }

  async disconnect() {
    this.socket?.close()
    this.queue?.close()
    this.socket = null
  }

  #onMessage(raw) {
    try {
      const message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      if (message.errorCode && message.errorCode !== 0) throw new Error(`ThingsBoard subscription error ${message.errorCode}.`)
      if (!message.data || typeof message.data !== 'object') return
      for (const [path, samples] of Object.entries(message.data)) {
        if (!Array.isArray(samples) || !samples.length) continue
        const sample = samples[samples.length - 1]
        if (!Array.isArray(sample) || sample.length < 2 || sample[1] == null) continue
        this.queue.push({ path, sourceTimestamp: new Date(Number(sample[0])).toISOString(), value: sample[1] })
      }
    } catch (error) {
      this.lastError = error
    }
  }
}
