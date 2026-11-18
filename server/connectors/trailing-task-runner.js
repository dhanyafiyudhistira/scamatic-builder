export function createTrailingTaskRunner({ task } = {}) {
  if (typeof task !== 'function') throw new TypeError('task must be a function')
  let stopped = false
  let runPromise = null
  let rerunRequested = false

  const drain = async () => {
    let result
    let lastError = null
    do {
      rerunRequested = false
      try {
        result = await task()
        lastError = null
      } catch (error) {
        lastError = error
      }
    } while (rerunRequested && !stopped)
    if (lastError) throw lastError
    return result
  }

  return {
    request() {
      if (stopped) return Promise.resolve(false)
      if (runPromise) {
        rerunRequested = true
        return runPromise
      }
      const current = drain()
      runPromise = current
      void current.then(
        () => { if (runPromise === current) runPromise = null },
        () => { if (runPromise === current) runPromise = null },
      )
      return current
    },
    async stop() {
      stopped = true
      rerunRequested = false
      try { await runPromise } catch {}
    },
  }
}
