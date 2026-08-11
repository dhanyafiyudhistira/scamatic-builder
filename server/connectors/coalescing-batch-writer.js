export class CoalescingBatchWriter {
  constructor({
    writeBatch,
    keyFor,
    batchSize = 500,
    flushMs = 100,
    maxPending = 20_000,
    onError = () => {},
    onSuccess = () => {},
    onDrop = () => {},
  }) {
    if (typeof writeBatch !== 'function') throw new TypeError('writeBatch must be a function.')
    if (typeof keyFor !== 'function') throw new TypeError('keyFor must be a function.')
    this.writeBatch = writeBatch
    this.keyFor = keyFor
    this.batchSize = positiveInteger(batchSize, 500)
    this.flushMs = positiveInteger(flushMs, 100)
    this.maxPending = positiveInteger(maxPending, 20_000)
    this.onError = onError
    this.onSuccess = onSuccess
    this.onDrop = onDrop
    this.pending = new Map()
    this.timer = null
    this.flushPromise = null
    this.closed = false
    this.nextRetryAt = 0
    this.retryDelayMs = this.flushMs
    this.stats = { queued: 0, coalesced: 0, written: 0, dropped: 0, failures: 0 }
  }

  start() {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => this.flush().catch(() => {}), this.flushMs)
    this.timer.unref?.()
  }

  enqueue(value) {
    if (this.closed) return false
    const rawKey = this.keyFor(value)
    if (rawKey == null || String(rawKey).length === 0) return false
    const key = String(rawKey)
    if (this.pending.has(key)) {
      this.pending.delete(key)
      this.stats.coalesced += 1
    }
    this.pending.set(key, value)
    this.stats.queued += 1
    this.#trimOverflow()
    if (this.pending.size >= this.batchSize) this.flush().catch(() => {})
    return true
  }

  async flush({ force = false } = {}) {
    if (this.flushPromise) return this.flushPromise
    if (!this.pending.size || (!force && Date.now() < this.nextRetryAt)) return

    const entries = [...this.pending.entries()].slice(0, this.batchSize)
    for (const [key] of entries) this.pending.delete(key)
    const batch = entries.map(([, value]) => value)
    const promise = this.#write(entries, batch)
    this.flushPromise = promise
    try {
      await promise
    } finally {
      if (this.flushPromise === promise) this.flushPromise = null
      if (!this.closed && this.pending.size >= this.batchSize && Date.now() >= this.nextRetryAt) {
        queueMicrotask(() => this.flush().catch(() => {}))
      }
    }
  }

  async close() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.flushPromise) await this.flushPromise
    let consecutiveFailures = 0
    while (this.pending.size && consecutiveFailures < 3) {
      const failuresBefore = this.stats.failures
      await this.flush({ force: true })
      consecutiveFailures = this.stats.failures > failuresBefore ? consecutiveFailures + 1 : 0
    }
    return this.snapshot()
  }

  snapshot() {
    return { ...this.stats, pending: this.pending.size }
  }

  async #write(entries, batch) {
    try {
      const result = await this.writeBatch(batch)
      this.stats.written += Number(result?.written ?? batch.length)
      this.nextRetryAt = 0
      this.retryDelayMs = this.flushMs
      try { this.onSuccess(this.snapshot()) } catch {}
    } catch (error) {
      this.stats.failures += 1
      this.nextRetryAt = Date.now() + this.retryDelayMs
      this.retryDelayMs = Math.min(30_000, this.retryDelayMs * 2)
      const newer = this.pending
      const restored = new Map()
      for (const [key, value] of entries) if (!newer.has(key)) restored.set(key, value)
      for (const entry of newer) restored.set(...entry)
      this.pending = restored
      this.#trimOverflow()
      try { this.onError(error, this.snapshot()) } catch {}
    }
  }

  #trimOverflow() {
    if (this.pending.size <= this.maxPending) return
    const overflow = this.pending.size - this.maxPending
    for (let index = 0; index < overflow; index += 1) {
      const oldest = this.pending.keys().next().value
      this.pending.delete(oldest)
    }
    this.stats.dropped += overflow
    try { this.onDrop(this.snapshot()) } catch {}
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
