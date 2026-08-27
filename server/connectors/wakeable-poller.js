export function createWakeablePoller({
  poll,
  intervalMs = 250,
  onError = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (typeof poll !== 'function') throw new TypeError('poll must be a function')
  const interval = positiveDelay(intervalMs, 250)
  let started = false
  let stopped = false
  let timer = null
  let runPromise = null
  let rerunRequested = false

  const run = () => {
    if (!started || stopped) return Promise.resolve(0)
    if (runPromise) return runPromise
    const current = Promise.resolve()
      .then(poll)
      .catch(error => {
        try { onError(error) } catch {}
        return 0
      })
    runPromise = current
    void current.finally(() => {
      if (runPromise !== current) return
      runPromise = null
      if (rerunRequested && !stopped) {
        rerunRequested = false
        void run()
      }
    })
    return current
  }

  return {
    start() {
      if (stopped) return Promise.resolve(0)
      if (started) return runPromise || Promise.resolve(0)
      started = true
      timer = setIntervalImpl(() => { if (!runPromise) void run() }, interval)
      timer?.unref?.()
      return run()
    },
    request() {
      if (!started || stopped) return false
      if (runPromise) rerunRequested = true
      else void run()
      return true
    },
    async stop() {
      stopped = true
      rerunRequested = false
      if (timer) clearIntervalImpl(timer)
      timer = null
      await runPromise
    },
  }
}

function positiveDelay(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
