import { normalizeTagEvent } from '../../shared/connector-contract.js'
import { FRESHNESS_SAMPLE_LIMIT, shouldObserveFreshnessInterval, tagFreshnessThresholds } from '../../shared/tag-freshness.js'
import { delay, exponentialBackoff } from './backoff.js'

export class ConnectorRuntime {
  constructor({ connector, environment, source, bindings, driverFactory, onEvent, onHealth, now = () => Date.now() }) {
    this.connector = connector
    this.environment = environment
    this.source = source
    this.bindings = bindings
    this.driverFactory = driverFactory
    this.onEvent = onEvent
    this.onHealth = onHealth
    this.now = now
    this.controller = new AbortController()
    this.lastSeen = new Map()
    this.lastValue = new Map()
    this.lastQuality = new Map()
    this.freshnessIntervals = new Map()
    this.sequence = new Map()
    this.feedbackWaiters = new Set()
    this.driver = null
    this.task = null
    this.startedAt = this.now()
  }

  start() {
    if (!this.task) this.task = this.#run()
    return this.task
  }

  async stop() {
    this.controller.abort()
    await this.driver?.disconnect().catch(() => {})
    await this.task?.catch(() => {})
  }

  async write(request, onAccepted) {
    if (!this.driver) throw new Error('Connector is offline.')
    const receipt = await this.driver.write(request)
    if (receipt.accepted) await onAccepted?.(receipt)
    if (!receipt.accepted || receipt.acknowledged || request.acknowledgment?.mode !== 'feedback-tag') return receipt
    const feedback = await this.waitForFeedback(request.acknowledgment.tagId, request.acknowledgment.expectedValue, request.timeoutMs)
    return { ...receipt, acknowledged: feedback, code: feedback ? 'FEEDBACK_ACK' : 'FEEDBACK_TIMEOUT' }
  }

  waitForFeedback(tagId, expectedValue, timeoutMs) {
    return new Promise(resolve => {
      const waiter = { tagId, expectedValue, resolve, timer: null }
      waiter.timer = setTimeout(() => { this.feedbackWaiters.delete(waiter); resolve(false) }, timeoutMs)
      this.feedbackWaiters.add(waiter)
    })
  }

  async #run() {
    let attempt = 0
    const staleTimer = setInterval(() => this.#detectStale(), 1_000)
    try {
      while (!this.controller.signal.aborted) {
        try {
          await this.onHealth('connecting', attempt ? `Reconnect attempt ${attempt}.` : 'Connecting.')
          this.driver = this.driverFactory()
          await this.driver.connect({ connectorId: this.connector.id, config: this.environment.config, secret: this.environment.secret })
          attempt = 0
          await this.onHealth('online', 'Connected to upstream telemetry.')
          for await (const raw of this.driver.subscribe(this.bindings)) {
            if (this.controller.signal.aborted) break
            await this.#consume(raw)
          }
          if (!this.controller.signal.aborted) throw new Error('Telemetry subscription ended.')
        } catch (error) {
          if (this.controller.signal.aborted) break
          await this.onHealth('offline', String(error.message || 'Connector disconnected.').slice(0, 300))
          await this.#markAll('disconnected')
          await this.driver?.disconnect().catch(() => {})
          await delay(exponentialBackoff(attempt++), this.controller.signal).catch(() => {})
        }
      }
    } finally {
      clearInterval(staleTimer)
    }
  }

  async #consume(raw) {
    const tag = this.bindings.find(item => item.path === raw.path)
    if (!tag) return
    const receivedAt = this.now()
    const previousSeenAt = this.lastSeen.get(tag.id)
    const previousQuality = this.lastQuality.get(tag.id)
    const intervalMs = previousSeenAt == null ? null : receivedAt - previousSeenAt
    if (shouldObserveFreshnessInterval(tag, intervalMs, previousQuality)) {
      const intervals = [...(this.freshnessIntervals.get(tag.id) || []), intervalMs].slice(-FRESHNESS_SAMPLE_LIMIT)
      this.freshnessIntervals.set(tag.id, intervals)
    }
    const sequence = (this.sequence.get(tag.id) || 0) + 1
    this.sequence.set(tag.id, sequence)
    const event = normalizeTagEvent({ workspaceId: this.connector.workspaceId, projectId: this.connector.projectId, sourceId: this.source.id, tag, value: raw.value, sourceTimestamp: raw.sourceTimestamp, sequence })
    this.lastSeen.set(tag.id, receivedAt)
    this.lastValue.set(tag.id, event.value)
    this.lastQuality.set(tag.id, 'good')
    for (const waiter of [...this.feedbackWaiters]) {
      if (waiter.tagId === tag.id && Object.is(event.value, waiter.expectedValue)) {
        clearTimeout(waiter.timer); this.feedbackWaiters.delete(waiter); waiter.resolve(true)
      }
    }
    await this.onEvent(event)
  }

  async #detectStale() {
    const now = this.now()
    for (const tag of this.bindings) {
      const policy = tagFreshnessThresholds(tag, this.freshnessIntervals.get(tag.id))
      if (policy.mode === 'event-driven') continue
      const elapsed = now - (this.lastSeen.get(tag.id) || this.startedAt)
      const quality = elapsed >= policy.disconnectAfterMs ? 'disconnected' : elapsed >= policy.staleAfterMs ? 'stale' : 'good'
      if (quality !== 'good' && quality !== this.lastQuality.get(tag.id)) await this.#emitQuality(tag, quality)
    }
  }

  async #markAll(quality) { for (const tag of this.bindings) await this.#emitQuality(tag, quality) }
  async #emitQuality(tag, quality) {
    this.lastQuality.set(tag.id, quality)
    const sequence = (this.sequence.get(tag.id) || 0) + 1
    this.sequence.set(tag.id, sequence)
    const event = normalizeTagEvent({ workspaceId: this.connector.workspaceId, projectId: this.connector.projectId, sourceId: this.source.id, tag, value: this.lastValue.has(tag.id) ? this.lastValue.get(tag.id) : defaultValue(tag.dataType), sourceTimestamp: new Date(this.now()).toISOString(), quality, sequence })
    await this.onEvent(event)
  }
}

function defaultValue(type) { return type === 'boolean' ? false : type === 'number' ? 0 : type === 'datetime' ? new Date(0).toISOString() : '' }
