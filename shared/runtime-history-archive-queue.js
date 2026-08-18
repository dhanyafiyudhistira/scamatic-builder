export function createRuntimeHistoryArchiveQueue({ maxPending = 2_000 } = {}) {
  const limit = boundedInteger(maxPending, 100, 10_000, 2_000)
  const entries = []
  let inFlight = null
  let nextBatchId = 1
  let dropped = 0

  function enqueue(batch) {
    const accepted = (Array.isArray(batch) ? batch : []).filter(validEntry)
    if (!accepted.length) return { accepted: 0, dropped }
    entries.push(...accepted.map(entry => ({ ...entry })))
    const protectedCount = inFlight?.count || 0
    const overflow = Math.max(0, entries.length - limit)
    if (overflow) {
      entries.splice(protectedCount, overflow)
      dropped += overflow
    }
    return { accepted: accepted.length, dropped }
  }

  function take(maxEntries = 1_000) {
    if (inFlight || !entries.length) return null
    const count = Math.min(entries.length, boundedInteger(maxEntries, 1, 1_000, 1_000))
    inFlight = { id: nextBatchId++, count }
    return { id: inFlight.id, entries: entries.slice(0, count).map(entry => ({ ...entry })) }
  }

  function acknowledge(id) {
    if (id !== inFlight?.id) return false
    entries.splice(0, inFlight.count)
    inFlight = null
    return true
  }

  function retry(id) {
    if (id !== inFlight?.id) return false
    inFlight = null
    return true
  }

  return {
    enqueue,
    take,
    acknowledge,
    retry,
    size: () => entries.length,
    stats: () => ({ pending: entries.length, dropped, inFlight: Boolean(inFlight) }),
    clear: () => { entries.length = 0; inFlight = null },
  }
}

function validEntry(entry) {
  return typeof entry?.tag === 'string'
    && entry.tag.length > 0
    && Number.isFinite(Number(entry.value))
    && Number.isFinite(Number(entry.timestamp))
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}
