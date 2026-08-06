export class TelemetryBatchWriter {
  constructor({ writeBatch, batchSize = 500, flushMs = 250, maxQueue = 20_000, onError = () => {}, onSuccess = () => {} }) {
    if (typeof writeBatch !== 'function') throw new TypeError('writeBatch must be a function.')
    this.writeBatch = writeBatch
    this.batchSize = batchSize
    this.flushMs = flushMs
    this.maxQueue = maxQueue
    this.onError = onError
    this.onSuccess = onSuccess
    this.queue = []
    this.timer = null
    this.flushing = false
    this.closed = false
    this.nextRetryAt = 0
    this.retryDelayMs = flushMs
    this.stats = { queued: 0, written: 0, dropped: 0, failures: 0 }
  }

  start() {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => this.flush().catch(() => {}), this.flushMs)
    this.timer.unref?.()
  }

  enqueue(event) {
    if (this.closed || event?.quality !== 'good' || !Number.isFinite(Number(event?.value))) return false
    this.queue.push(event)
    this.stats.queued += 1
    if (this.queue.length > this.maxQueue) {
      const overflow = this.queue.length - this.maxQueue
      this.queue.splice(0, overflow)
      this.stats.dropped += overflow
    }
    if (this.queue.length >= this.batchSize) this.flush().catch(() => {})
    return true
  }

  async flush({ force = false } = {}) {
    if (this.flushing || !this.queue.length || (!force && Date.now() < this.nextRetryAt)) return
    this.flushing = true
    const batch = this.queue.splice(0, this.batchSize)
    try {
      const result = await this.writeBatch(batch)
      this.stats.written += Number(result?.inserted ?? batch.length)
      this.nextRetryAt = 0
      this.retryDelayMs = this.flushMs
      try { this.onSuccess({ ...this.stats, pending: this.queue.length }) } catch {}
    } catch (error) {
      this.stats.failures += 1
      this.nextRetryAt = Date.now() + this.retryDelayMs
      this.retryDelayMs = Math.min(30_000, this.retryDelayMs * 2)
      this.queue = [...batch, ...this.queue]
      if (this.queue.length > this.maxQueue) {
        const overflow = this.queue.length - this.maxQueue
        this.queue.splice(0, overflow)
        this.stats.dropped += overflow
      }
      try { this.onError(error, { ...this.stats, pending: this.queue.length }) } catch {}
    } finally {
      this.flushing = false
    }
  }

  async close() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (let attempt = 0; attempt < 3 && this.queue.length; attempt += 1) await this.flush({ force: true })
    return { ...this.stats, pending: this.queue.length }
  }
}
