export function createSimulationTelemetryQueue({ maxPending = 256 } = {}) {
  const limit = boundedInteger(maxPending, 8, 1024, 256)
  const jobs = []
  let nextId = 1
  let inFlightId = null

  function enqueue(values, { preserveOrder = false } = {}) {
    const normalized = normalizeValues(values)
    if (!Object.keys(normalized).length) return { accepted: false, reason: 'empty' }
    const tail = jobs.at(-1)
    if (!preserveOrder && tail?.kind === 'steady' && tail.id !== inFlightId) {
      tail.values = { ...tail.values, ...normalized }
      return { accepted: true, coalesced: true, id: tail.id }
    }
    if (jobs.length >= limit) return { accepted: false, reason: 'full' }
    const job = { id: nextId++, kind: preserveOrder ? 'ordered' : 'steady', values: normalized }
    jobs.push(job)
    return { accepted: true, coalesced: false, id: job.id }
  }

  function enqueueHeartbeat() {
    const existing = jobs.find(job => job.kind === 'heartbeat')
    if (existing) return { accepted: true, coalesced: true, id: existing.id }
    if (jobs.length >= limit) return { accepted: false, reason: 'full' }
    const job = { id: nextId++, kind: 'heartbeat', values: {} }
    jobs.push(job)
    return { accepted: true, coalesced: false, id: job.id }
  }

  function take() {
    if (inFlightId != null || !jobs.length) return null
    inFlightId = jobs[0].id
    return { ...jobs[0], values: { ...jobs[0].values } }
  }

  function acknowledge(id) {
    if (id !== inFlightId || jobs[0]?.id !== id) return false
    jobs.shift()
    inFlightId = null
    return true
  }

  function retry(id) {
    if (id !== inFlightId || jobs[0]?.id !== id) return false
    inFlightId = null
    return true
  }

  return {
    enqueue,
    enqueueHeartbeat,
    take,
    acknowledge,
    retry,
    size: () => jobs.length,
    clear: () => { jobs.length = 0; inFlightId = null },
  }
}

function normalizeValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {}
  return Object.fromEntries(Object.entries(values).filter(([key]) => String(key).length > 0))
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.min(max, Math.max(min, number)) : fallback
}
