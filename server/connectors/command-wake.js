const COMMAND_WAKE_ID = /^[a-zA-Z0-9:_-]{1,120}$/

export function normalizeCommandWakeId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  return COMMAND_WAKE_ID.test(id) ? id : null
}

export function createCommandWakeBuffer({ maxPending = 200 } = {}) {
  const capacity = boundedInteger(maxPending, 1, 2_000, 200)
  const ids = new Set()
  let received = 0
  let duplicates = 0
  let dropped = 0
  let invalid = 0

  return {
    push(value) {
      const id = normalizeCommandWakeId(value)
      if (!id) {
        invalid += 1
        return false
      }
      received += 1
      if (ids.has(id)) {
        duplicates += 1
        return true
      }
      if (ids.size >= capacity) {
        ids.delete(ids.keys().next().value)
        dropped += 1
      }
      ids.add(id)
      return true
    },
    take(limit = 20) {
      const count = boundedInteger(limit, 1, capacity, Math.min(20, capacity))
      const selected = []
      for (const id of ids) {
        selected.push(id)
        ids.delete(id)
        if (selected.length >= count) break
      }
      return selected
    },
    snapshot() {
      return { pending: ids.size, capacity, received, duplicates, dropped, invalid }
    },
  }
}

export function buildCommandCandidateFilter({ pendingIds = [], targetedIds = [] } = {}) {
  const base = { status: 'authorized', executionMode: 'worker' }
  const pending = new Set(pendingIds.map(normalizeCommandWakeId).filter(Boolean))
  const targeted = [...new Set(targetedIds.map(normalizeCommandWakeId).filter(Boolean))]
  if (targeted.length) {
    const available = targeted.filter(id => !pending.has(id))
    return available.length ? { ...base, _id: { $in: available } } : null
  }
  return pending.size ? { ...base, _id: { $nin: [...pending] } } : base
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}
