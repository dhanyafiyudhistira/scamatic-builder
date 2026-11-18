export function createRuntimeTelemetryFrame({ onFlush, schedule, cancel }) {
  let timer = null
  let pending = []

  const deliver = () => {
    timer = null
    const events = pending
    pending = []
    if (events.length) onFlush(events)
  }

  return {
    enqueue(events) {
      if (!Array.isArray(events) || events.length === 0) return false
      pending.push(...events)
      if (timer === null) timer = schedule(deliver)
      return true
    },
    flush() {
      if (timer !== null) cancel(timer)
      deliver()
    },
    clear() {
      if (timer !== null) cancel(timer)
      timer = null
      pending = []
    },
  }
}
