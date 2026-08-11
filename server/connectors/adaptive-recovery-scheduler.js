export function createAdaptiveRecoveryScheduler({
  recover,
  activeDelayMs = 1_000,
  idleDelayMs = 30_000,
  onError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
} = {}) {
  if (typeof recover !== 'function') throw new TypeError('recover must be a function')
  const activeDelay = positiveDelay(activeDelayMs, 1_000)
  const idleDelay = Math.max(activeDelay, positiveDelay(idleDelayMs, 30_000))
  let started = false
  let stopped = false
  let timer = null
  let timerDueAt = Number.POSITIVE_INFINITY
  let runPromise = null
  let rerunRequested = false

  const cancelTimer = () => {
    if (timer) clearTimer(timer)
    timer = null
    timerDueAt = Number.POSITIVE_INFINITY
  }

  const schedule = delayMs => {
    if (!started || stopped) return false
    const delay = Math.max(0, Number(delayMs) || 0)
    const dueAt = now() + delay
    if (timer && timerDueAt <= dueAt) return false
    cancelTimer()
    timerDueAt = dueAt
    timer = setTimer(() => {
      timer = null
      timerDueAt = Number.POSITIVE_INFINITY
      void run()
    }, delay)
    timer?.unref?.()
    return true
  }

  const run = async () => {
    if (!started || stopped) return 0
    if (runPromise) {
      rerunRequested = true
      return runPromise
    }
    cancelTimer()
    let nextDelay = idleDelay
    runPromise = (async () => {
      try {
        const recovered = nonNegativeCount(await recover())
        nextDelay = recovered > 0 ? activeDelay : idleDelay
        return recovered
      } catch (error) {
        nextDelay = activeDelay
        try { onError(error) } catch {}
        return 0
      }
    })()
    try {
      return await runPromise
    } finally {
      runPromise = null
      if (!stopped) {
        if (rerunRequested) {
          rerunRequested = false
          schedule(0)
        } else {
          schedule(nextDelay)
        }
      }
    }
  }

  return {
    start() {
      if (stopped) return Promise.resolve(0)
      if (started) return runPromise || Promise.resolve(0)
      started = true
      return run()
    },
    request() {
      if (!started || stopped) return false
      if (runPromise) {
        rerunRequested = true
        return true
      }
      return schedule(0)
    },
    async stop() {
      stopped = true
      rerunRequested = false
      cancelTimer()
      await runPromise
    },
  }
}

function positiveDelay(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeCount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}
