const IDENTIFIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/

export function chartStorageConfig(environment = process.env) {
  const uri = String(environment.CHART_MONGO_URI || '').trim()
  const enabled = Boolean(uri)
  const config = {
    enabled,
    uri,
    dbName: validatedIdentifier(environment.CHART_MONGO_DB || 'scamatic_telemetry', 'CHART_MONGO_DB'),
    collectionName: validatedIdentifier(environment.CHART_MONGO_COLLECTION || 'chart_samples', 'CHART_MONGO_COLLECTION'),
    retentionDays: boundedInteger(environment.CHART_MONGO_RETENTION_DAYS, 1, 3650, 30),
    batchSize: boundedInteger(environment.CHART_MONGO_BATCH_SIZE, 10, 2000, 500),
    flushMs: boundedInteger(environment.CHART_MONGO_FLUSH_MS, 50, 5000, 250),
    maxQueue: boundedInteger(environment.CHART_MONGO_MAX_QUEUE, 100, 200_000, 20_000),
    maxPoolSize: boundedInteger(environment.CHART_MONGO_MAX_POOL_SIZE, 2, 100, 20),
    maxBootstrapPoints: boundedInteger(environment.CHART_HISTORY_MAX_BOOTSTRAP_POINTS, 100, 50_000, 10_000),
  }
  if (!enabled) return config
  validateMongoUri(uri, 'CHART_MONGO_URI')

  const controlUri = String(environment.MONGO_URI || '').trim()
  const sharedCluster = Boolean(controlUri) && mongoAuthority(controlUri) === mongoAuthority(uri)
  if (sharedCluster && environment.NODE_ENV === 'production' && environment.CHART_MONGO_ALLOW_SHARED_CLUSTER !== 'true') {
    throw configurationError('CHART_MONGO_URI must use a separate MongoDB cluster from MONGO_URI in production.')
  }
  return { ...config, sharedCluster }
}

export function publicChartStorageConfig(config) {
  return {
    enabled: Boolean(config?.enabled),
    engine: config?.enabled ? 'mongodb-timeseries' : 'session-memory',
    isolatedCluster: Boolean(config?.enabled && !config?.sharedCluster),
    retentionDays: config?.enabled ? config.retentionDays : null,
  }
}

function validateMongoUri(value, name) {
  let url
  try { url = new URL(value) } catch { throw configurationError(`${name} must be a valid MongoDB URI.`) }
  if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol) || !url.hostname) throw configurationError(`${name} must use mongodb:// or mongodb+srv://.`)
}

function mongoAuthority(value) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host.toLowerCase()}`
  } catch {
    return ''
  }
}

function validatedIdentifier(value, name) {
  const normalized = String(value || '').trim()
  if (!IDENTIFIER_PATTERN.test(normalized)) throw configurationError(`${name} contains unsupported characters.`)
  return normalized
}

function boundedInteger(value, min, max, fallback) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw configurationError(`Chart storage numeric configuration must be between ${min} and ${max}.`)
  return parsed
}

function configurationError(message) {
  return Object.assign(new Error(message), { code: 'CHART_STORAGE_CONFIGURATION' })
}
