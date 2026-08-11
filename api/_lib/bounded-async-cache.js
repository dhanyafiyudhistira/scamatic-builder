export function createBoundedAsyncCache({ maxEntries = 8, ttlMs = 60_000, now = Date.now } = {}) {
  const capacity = boundedInteger(maxEntries, 1, 64, 8)
  const lifetime = boundedInteger(ttlMs, 1_000, 300_000, 60_000)
  const entries = new Map()

  async function get(key, loader) {
    const cacheKey = String(key || '')
    if (!cacheKey || typeof loader !== 'function') throw new TypeError('A cache key and loader are required.')
    const timestamp = now()
    const cached = entries.get(cacheKey)
    if (cached && cached.expiresAt > timestamp) {
      entries.delete(cacheKey)
      entries.set(cacheKey, cached)
      return cached.promise
    }
    if (cached) entries.delete(cacheKey)

    const promise = Promise.resolve().then(loader)
    const entry = { expiresAt: timestamp + lifetime, promise }
    entries.set(cacheKey, entry)
    while (entries.size > capacity) entries.delete(entries.keys().next().value)

    try {
      const value = await promise
      if (value == null && entries.get(cacheKey) === entry) entries.delete(cacheKey)
      return value
    } catch (error) {
      if (entries.get(cacheKey) === entry) entries.delete(cacheKey)
      throw error
    }
  }

  return {
    get,
    clear: () => entries.clear(),
    size: () => entries.size,
  }
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}
