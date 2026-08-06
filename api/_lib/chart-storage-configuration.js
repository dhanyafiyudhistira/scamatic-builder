import { ChartStorageConfiguration, ChartStorageSecret } from './models.js'
import { chartStorageSecretId, decryptChartStorageSecret } from './connector-secrets.js'
import { chartStorageConfig, publicChartStorageConfig } from '../../shared/chart-storage-config.js'

export async function loadWorkspaceChartStorage(workspaceId, { environment = process.env, allowEnvironmentFallback = true } = {}) {
  const record = await ChartStorageConfiguration.findOne({ workspaceId }).lean()
  if (record) {
    if (record.enabled && record.secretConfiguredAt) {
      const secretRecord = await ChartStorageSecret.findById(chartStorageSecretId(workspaceId))
        .select('+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion')
        .lean()
      if (secretRecord) {
        const { uri } = decryptChartStorageSecret(secretRecord, { workspaceId })
        const config = storedChartStorageConfig(record, uri, environment)
        return { source: 'workspace', config, record, public: publicWorkspaceChartStorage(record, config, 'workspace') }
      }
    }
    const config = chartStorageConfig({})
    return { source: 'workspace', config, record, public: publicWorkspaceChartStorage(record, config, 'workspace') }
  }
  if (allowEnvironmentFallback) {
    const config = chartStorageConfig(environment)
    return { source: config.enabled ? 'environment' : 'disabled', config, record, public: publicWorkspaceChartStorage(record, config, config.enabled ? 'environment' : 'disabled') }
  }
  const config = chartStorageConfig({})
  return { source: 'disabled', config, record, public: publicWorkspaceChartStorage(record, config, 'disabled') }
}

export function storedChartStorageConfig(record, uri, baseEnvironment = process.env) {
  return chartStorageConfig({
    ...baseEnvironment,
    CHART_MONGO_URI: uri,
    CHART_MONGO_DB: record.dbName,
    CHART_MONGO_COLLECTION: record.collectionName,
    CHART_MONGO_RETENTION_DAYS: String(record.retentionDays),
    CHART_MONGO_BATCH_SIZE: String(record.batchSize),
    CHART_MONGO_FLUSH_MS: String(record.flushMs),
    CHART_MONGO_MAX_QUEUE: String(record.maxQueue),
    CHART_MONGO_MAX_POOL_SIZE: String(record.maxPoolSize),
    CHART_HISTORY_MAX_BOOTSTRAP_POINTS: String(record.maxBootstrapPoints),
  })
}

export function publicWorkspaceChartStorage(record, config, source = 'disabled') {
  const workspaceManaged = source === 'workspace'
  const workspaceEnabled = workspaceManaged ? Boolean(record?.enabled && config?.enabled) : Boolean(config?.enabled)
  return {
    ...publicChartStorageConfig(config),
    source,
    enabled: source !== 'disabled' && workspaceEnabled,
    engine: workspaceEnabled ? 'mongodb-timeseries' : 'session-memory',
    isolatedCluster: workspaceEnabled ? Boolean(!config?.sharedCluster) : false,
    targetLabel: workspaceManaged ? record?.targetLabel || 'MongoDB' : source === 'environment' ? 'Environment managed' : '',
    secretConfigured: workspaceManaged ? Boolean(record?.secretConfiguredAt) : Boolean(config?.enabled),
    dbName: workspaceManaged ? record?.dbName || '' : config?.enabled ? config.dbName : '',
    collectionName: workspaceManaged ? record?.collectionName || '' : config?.enabled ? config.collectionName : '',
    retentionDays: workspaceManaged ? record?.retentionDays ?? null : config?.enabled ? config.retentionDays : null,
    batchSize: workspaceManaged ? record?.batchSize ?? null : config?.enabled ? config.batchSize : null,
    flushMs: workspaceManaged ? record?.flushMs ?? null : config?.enabled ? config.flushMs : null,
    maxQueue: workspaceManaged ? record?.maxQueue ?? null : config?.enabled ? config.maxQueue : null,
    maxPoolSize: workspaceManaged ? record?.maxPoolSize ?? null : config?.enabled ? config.maxPoolSize : null,
    maxBootstrapPoints: workspaceManaged ? record?.maxBootstrapPoints ?? null : config?.enabled ? config.maxBootstrapPoints : null,
    health: workspaceManaged
      ? record?.enabled
        ? record?.health || { state: 'unconfigured', message: '', checkedAt: null }
        : { state: 'unconfigured', message: 'Workspace Chart archive is disabled.', checkedAt: record?.health?.checkedAt || null }
      : { state: config?.enabled ? 'ready' : 'unconfigured', message: config?.enabled ? 'Managed by server environment.' : 'Chart archive is not configured.', checkedAt: null },
    updatedAt: record?.updatedAt || null,
  }
}
