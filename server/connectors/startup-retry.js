export async function retryStartup(operation, {
  maxAttempts = 0,
  initialDelayMs = 500,
  maxDelayMs = 10_000,
  shouldRetry = () => true,
  onRetry = () => {},
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
} = {}) {
  let attempt = 0
  while (true) {
    attempt += 1
    try {
      return await operation(attempt)
    } catch (error) {
      const exhausted = Number(maxAttempts) > 0 && attempt >= Number(maxAttempts)
      if (exhausted || !shouldRetry(error)) throw error
      const delayMs = retryDelayMs(attempt, { initialDelayMs, maxDelayMs })
      await onRetry({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }
}

export function retryDelayMs(attempt, { initialDelayMs = 500, maxDelayMs = 10_000 } = {}) {
  const base = Math.max(50, Number(initialDelayMs) || 500)
  const cap = Math.max(base, Number(maxDelayMs) || 10_000)
  return Math.min(cap, base * (2 ** Math.max(0, Number(attempt) - 1)))
}
