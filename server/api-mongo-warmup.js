import { retryStartup } from './connectors/startup-retry.js'

export async function warmApiMongo({
  connect,
  shouldRetry,
  env = process.env,
  sleep,
  onState = () => {},
} = {}) {
  if (typeof connect !== 'function') throw new TypeError('connect must be a function')
  const config = apiMongoWarmupConfig(env)
  let attempts = 0

  try {
    const connection = await retryStartup(async attempt => {
      attempts = attempt
      onState({ phase: 'connecting-mongodb', attempt })
      return connect()
    }, {
      ...config,
      shouldRetry,
      ...(sleep ? { sleep } : {}),
      onRetry: ({ attempt, delayMs, error }) => onState({
        phase: 'retrying-mongodb',
        attempt,
        delayMs,
        errorCode: safeErrorCode(error),
      }),
    })
    onState({ phase: 'ready', attempt: attempts })
    return connection
  } catch (error) {
    onState({ phase: 'failed', attempt: attempts, errorCode: safeErrorCode(error) })
    throw error
  }
}

export function apiMongoWarmupConfig(env = process.env) {
  return {
    maxAttempts: nonNegativeInteger(env.API_MONGO_STARTUP_MAX_ATTEMPTS, 0),
    initialDelayMs: positiveInteger(env.API_MONGO_RETRY_INITIAL_MS, 500),
    maxDelayMs: positiveInteger(env.API_MONGO_RETRY_MAX_MS, 10_000),
  }
}

function safeErrorCode(error) {
  return String(error?.code || error?.name || 'DATABASE_UNAVAILABLE').slice(0, 80)
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}
