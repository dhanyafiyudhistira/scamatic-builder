export function createCommandVersionCache({
  maxEntries = 32,
  ttlMs = 5 * 60_000,
  now = Date.now,
} = {}) {
  const capacity = boundedInteger(maxEntries, 1, 256, 32)
  const lifetime = boundedInteger(ttlMs, 1_000, 60 * 60_000, 5 * 60_000)
  const entries = new Map()
  let hits = 0
  let misses = 0
  let batchLoads = 0
  let evictions = 0

  async function load(versionIds, loadMany) {
    if (typeof loadMany !== 'function') throw new TypeError('A version batch loader is required.')
    const ids = [...new Set((versionIds || []).map(value => String(value || '')).filter(Boolean))]
    const timestamp = safeNow(now)
    const result = new Map()
    const missing = []

    for (const id of ids) {
      const cached = entries.get(id)
      if (cached && cached.expiresAt > timestamp) {
        hits += 1
        entries.delete(id)
        entries.set(id, cached)
        result.set(id, cached.value)
        continue
      }
      if (cached) entries.delete(id)
      misses += 1
      missing.push(id)
    }

    if (missing.length) {
      batchLoads += 1
      const loaded = await loadMany(missing)
      const loadedById = new Map((Array.isArray(loaded) ? loaded : [])
        .filter(Boolean)
        .map(version => [String(version._id || version.id || ''), version]))
      const expiresAt = timestamp + lifetime
      for (const id of missing) {
        const version = loadedById.get(id)
        if (!version) continue
        entries.set(id, { value: version, expiresAt })
        result.set(id, version)
      }
      while (entries.size > capacity) {
        entries.delete(entries.keys().next().value)
        evictions += 1
      }
    }

    return result
  }

  return {
    load,
    clear() {
      entries.clear()
    },
    snapshot() {
      return { entries: entries.size, capacity, ttlMs: lifetime, hits, misses, batchLoads, evictions }
    },
  }
}

function safeNow(now) {
  const value = Number(now())
  return Number.isFinite(value) && value >= 0 ? value : Date.now()
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}
