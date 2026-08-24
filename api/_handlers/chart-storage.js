import { connectMongo, runMongoTransaction } from '../_lib/mongo.js'
import { AuditEvent, ChartStorageConfiguration, ChartStorageSecret } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireWorkspacePermission } from '../_lib/authorization.js'
import { chartStorageSecretId, decryptChartStorageSecret, encryptChartStorageSecret } from '../_lib/connector-secrets.js'
import { assertSafeChartMongoTarget, chartStorageTargetLabel, normalizeChartMongoUri } from '../_lib/chart-storage-target.js'
import { ensureChartTelemetryStore } from '../_lib/chart-telemetry-store.js'
import { loadWorkspaceChartStorage, publicWorkspaceChartStorage, storedChartStorageConfig } from '../_lib/chart-storage-configuration.js'
import { enforceRateLimit, redactMetadata, requestId } from '../_lib/security.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal || !requireWorkspacePermission(principal, res, PERMISSIONS.CHART_STORAGE_MANAGE)) return
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  if (req.method !== 'GET' && !requireCsrf(req, res, principal)) return
  const limit = req.method === 'GET' ? 120 : 8
  if (!(await enforceRateLimit(req, res, `chart-storage-${req.method.toLowerCase()}`, { limit, windowMs: 60_000, identity: `${principal.id}:${principal.workspaceId}` }))) return

  try {
    await connectMongo()
    if (req.method === 'GET') {
      const resolved = await loadWorkspaceChartStorage(principal.workspaceId)
      return res.status(200).json({ storage: resolved.public })
    }
    if (req.method === 'POST') return testStorage(req, res, principal)
    if (req.method === 'PUT') return saveStorage(req, res, principal)
    return removeStorage(req, res, principal)
  } catch (error) {
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code })
    if (['CONNECTOR_KEY_MISSING', 'CONNECTOR_KEY_INVALID'].includes(error?.code)) {
      return res.status(503).json({ error: 'Server secret encryption is not configured.', code: 'CHART_STORAGE_ENCRYPTION_UNAVAILABLE', correlationId: requestId(req) })
    }
    if (['CHART_STORAGE_UNAVAILABLE', 'CHART_STORAGE_CONFIGURATION', 'CHART_STORAGE_COLLECTION_TYPE'].includes(error?.code)) {
      return res.status(422).json({ error: 'MongoDB Chart storage could not be validated.', code: error.code, correlationId: requestId(req) })
    }
    return res.status(500).json({ error: 'Unable to process Chart storage configuration.', code: 'CHART_STORAGE_REQUEST_FAILED', correlationId: requestId(req) })
  }
}

async function testStorage(req, res, principal) {
  const candidate = await candidateConfiguration(req.body, principal.workspaceId)
  await assertSafeChartMongoTarget(candidate.config.uri)
  await updateHealth(principal.workspaceId, 'testing', 'Validating isolated MongoDB storage.')
  try {
    await ensureChartTelemetryStore({ config: candidate.config })
    await updateHealth(principal.workspaceId, 'ready', 'MongoDB time-series storage is ready.')
    await audit(principal, 'chart-storage.test.succeeded', { target: chartStorageTargetLabel(candidate.config.uri) })
    return res.status(200).json({ ok: true, message: 'MongoDB Chart storage connection succeeded.' })
  } catch (error) {
    await updateHealth(principal.workspaceId, 'error', 'MongoDB Chart storage validation failed.')
    await audit(principal, 'chart-storage.test.failed', { code: error?.code || 'CONNECTION_FAILED' })
    throw error
  }
}

async function saveStorage(req, res, principal) {
  const enabled = req.body?.enabled !== false
  const candidate = await candidateConfiguration(req.body, principal.workspaceId, { allowMissingUri: !enabled })
  const uri = candidate.config.uri ? await assertSafeChartMongoTarget(candidate.config.uri) : ''
  if (enabled) await ensureChartTelemetryStore({ config: candidate.config })
  const now = new Date()
  const record = await runMongoTransaction(async session => {
    const transactionOptions = session ? { session } : {}
    if (candidate.rotateSecret) {
      const encrypted = encryptChartStorageSecret({ uri }, { workspaceId: principal.workspaceId })
      await ChartStorageSecret.findOneAndUpdate(
        { _id: chartStorageSecretId(principal.workspaceId) },
        { $set: { workspaceId: principal.workspaceId, ...encrypted, rotatedBy: principal.id } },
        { upsert: true, new: true, setDefaultsOnInsert: true, ...transactionOptions },
      )
    }
    return ChartStorageConfiguration.findOneAndUpdate(
      { _id: principal.workspaceId },
      {
        $set: {
          workspaceId: principal.workspaceId,
          enabled,
          dbName: candidate.config.dbName,
          collectionName: candidate.config.collectionName,
          retentionDays: candidate.config.retentionDays,
          batchSize: candidate.config.batchSize,
          flushMs: candidate.config.flushMs,
          maxQueue: candidate.config.maxQueue,
          maxPoolSize: candidate.config.maxPoolSize,
          maxBootstrapPoints: candidate.config.maxBootstrapPoints,
          targetLabel: uri ? chartStorageTargetLabel(uri) : candidate.existing?.targetLabel || '',
          secretConfiguredAt: candidate.rotateSecret ? now : candidate.existing?.secretConfiguredAt,
          health: enabled
            ? { state: 'ready', message: 'MongoDB time-series storage is ready.', checkedAt: now }
            : { state: 'unconfigured', message: 'Workspace Chart archive is disabled.', checkedAt: now },
          updatedBy: principal.id,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, ...transactionOptions },
    )
  })
  await audit(principal, 'chart-storage.updated', {
    enabled: record.enabled,
    dbName: record.dbName,
    collectionName: record.collectionName,
    retentionDays: record.retentionDays,
    target: record.targetLabel,
    secretRotated: candidate.rotateSecret,
  })
  return res.status(200).json({ storage: publicWorkspaceChartStorage(record.toObject(), candidate.config, 'workspace') })
}

async function removeStorage(req, res, principal) {
  if (String(req.body?.confirmation || '') !== 'REMOVE') return res.status(400).json({ error: 'confirmation must equal REMOVE.' })
  await runMongoTransaction(async session => {
    const transactionOptions = session ? { session } : {}
    await Promise.all([
      ChartStorageConfiguration.deleteOne({ workspaceId: principal.workspaceId }, transactionOptions),
      ChartStorageSecret.deleteOne({ workspaceId: principal.workspaceId }, transactionOptions),
    ])
  })
  await audit(principal, 'chart-storage.removed', {})
  return res.status(200).json({ ok: true })
}

async function candidateConfiguration(input, workspaceId, { allowMissingUri = false } = {}) {
  const existing = await ChartStorageConfiguration.findOne({ workspaceId }).lean()
  const providedUri = String(input?.uri || '').trim()
  let uri = providedUri
  if (!uri && existing?.secretConfiguredAt) {
    const secretRecord = await ChartStorageSecret.findById(chartStorageSecretId(workspaceId))
      .select('+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion')
      .lean()
    if (secretRecord) uri = decryptChartStorageSecret(secretRecord, { workspaceId }).uri
  }
  if (!uri && !allowMissingUri) throw Object.assign(new Error('Enter a MongoDB URI before testing or saving.'), { statusCode: 400, code: 'CHART_STORAGE_SECRET_REQUIRED' })
  if (uri) normalizeChartMongoUri(uri)
  const record = {
    dbName: input?.dbName ?? existing?.dbName ?? 'scamatic_telemetry',
    collectionName: input?.collectionName ?? existing?.collectionName ?? 'chart_samples',
    retentionDays: input?.retentionDays ?? existing?.retentionDays ?? 30,
    batchSize: input?.batchSize ?? existing?.batchSize ?? 500,
    flushMs: input?.flushMs ?? existing?.flushMs ?? 250,
    maxQueue: input?.maxQueue ?? existing?.maxQueue ?? 20_000,
    maxPoolSize: input?.maxPoolSize ?? existing?.maxPoolSize ?? 20,
    maxBootstrapPoints: input?.maxBootstrapPoints ?? existing?.maxBootstrapPoints ?? 10_000,
  }
  const config = storedChartStorageConfig(record, uri)
  return { config, existing, rotateSecret: Boolean(providedUri) }
}

async function updateHealth(workspaceId, state, message) {
  await ChartStorageConfiguration.updateOne({ workspaceId }, { $set: { health: { state, message, checkedAt: new Date() } } })
}

function audit(principal, action, metadata) {
  return AuditEvent.create({
    workspaceId: principal.workspaceId,
    projectId: null,
    actorId: principal.id,
    action,
    targetType: 'chart-storage',
    targetId: principal.workspaceId,
    metadata: redactMetadata(metadata),
  })
}

export function sanitizeChartStorageInput(input = {}, environment = process.env) {
  const uri = normalizeChartMongoUri(input.uri, environment)
  const record = {
    dbName: input.dbName || 'scamatic_telemetry',
    collectionName: input.collectionName || 'chart_samples',
    retentionDays: input.retentionDays ?? 30,
    batchSize: input.batchSize ?? 500,
    flushMs: input.flushMs ?? 250,
    maxQueue: input.maxQueue ?? 20_000,
    maxPoolSize: input.maxPoolSize ?? 20,
    maxBootstrapPoints: input.maxBootstrapPoints ?? 10_000,
  }
  return storedChartStorageConfig(record, uri, environment)
}
