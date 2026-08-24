export function exponentialBackoff(attempt, { baseMs = 500, maxMs = 30_000, jitter = 0.25, random = Math.random } = {}) {
  const capped = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt)))
  const spread = capped * Math.max(0, Math.min(1, jitter))
  return Math.max(0, Math.round(capped - spread + random() * spread * 2))
}
export function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('Aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('Aborted')) }, { once: true })
  })
}
