import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chartStorageConfig, publicChartStorageConfig } from '../shared/chart-storage-config.js'
import { runtimeChartHistoryRequest } from '../shared/runtime-chart-history.js'
import { normalizeChartTelemetryEvent } from '../api/_lib/chart-telemetry-store.js'
import { publicWorkspaceChartStorage, storedChartStorageConfig, workspaceChartStorageMetadataConfig } from '../api/_lib/chart-storage-configuration.js'
import { chartStorageTargetLabel, normalizeChartMongoUri } from '../api/_lib/chart-storage-target.js'
import { decryptChartStorageSecret, encryptChartStorageSecret } from '../api/_lib/connector-secrets.js'
import { TelemetryBatchWriter } from '../server/connectors/telemetry-batch-writer.js'

test('Chart storage is disabled safely when no dedicated URI is configured', () => {
  const config = chartStorageConfig({})
  assert.equal(config.enabled, false)
  assert.equal(config.dbName, 'scamatic_telemetry')
  assert.deepEqual(publicChartStorageConfig(config), {
    enabled: false,
    engine: 'session-memory',
    isolatedCluster: false,
    retentionDays: null,
  })
})

test('production Chart storage rejects the control-plane MongoDB cluster', () => {
  assert.throws(() => chartStorageConfig({
    NODE_ENV: 'production',
    MONGO_URI: 'mongodb+srv://control:secret@primary.example/control',
    CHART_MONGO_URI: 'mongodb+srv://telemetry:secret@primary.example/telemetry',
  }), error => error.code === 'CHART_STORAGE_CONFIGURATION')

  const config = chartStorageConfig({
    NODE_ENV: 'production',
    MONGO_URI: 'mongodb+srv://control:secret@primary.example/control',
    CHART_MONGO_URI: 'mongodb+srv://telemetry:secret@archive.example/telemetry',
  })
  assert.equal(config.enabled, true)
  assert.equal(config.sharedCluster, false)
  assert.equal('uri' in publicChartStorageConfig(config), false)
})

test('web-managed Chart storage exposes safe metadata without returning its URI', () => {
  const config = storedChartStorageConfig({
    dbName: 'workspace_telemetry',
    collectionName: 'chart_samples',
    retentionDays: 45,
    batchSize: 250,
    flushMs: 500,
    maxQueue: 5000,
    maxPoolSize: 12,
    maxBootstrapPoints: 8000,
  }, 'mongodb+srv://writer:secret@archive.example/telemetry', {})
  const publicConfig = publicWorkspaceChartStorage({
    enabled: true,
    secretConfiguredAt: new Date(),
    targetLabel: 'arc•••.archive.example',
    dbName: config.dbName,
    collectionName: config.collectionName,
    retentionDays: config.retentionDays,
    batchSize: config.batchSize,
    flushMs: config.flushMs,
    maxQueue: config.maxQueue,
    maxPoolSize: config.maxPoolSize,
    maxBootstrapPoints: config.maxBootstrapPoints,
    health: { state: 'ready', message: 'ready', checkedAt: new Date() },
  }, config, 'workspace')
  assert.equal(publicConfig.enabled, true)
  assert.equal(publicConfig.secretConfigured, true)
  assert.equal(publicConfig.maxPoolSize, 12)
  assert.equal(JSON.stringify(publicConfig).includes('writer'), false)
  assert.equal(JSON.stringify(publicConfig).includes('writer:secret'), false)
  assert.equal('uri' in publicConfig, false)
})

test('an explicitly disabled workspace archive remains workspace-managed', () => {
  const publicConfig = publicWorkspaceChartStorage({
    enabled: false,
    secretConfiguredAt: new Date(),
    targetLabel: 'arc•••.archive.example',
    dbName: 'workspace_telemetry',
    collectionName: 'chart_samples',
    retentionDays: 30,
  }, chartStorageConfig({}), 'workspace')
  assert.equal(publicConfig.source, 'workspace')
  assert.equal(publicConfig.enabled, false)
  assert.equal(publicConfig.engine, 'session-memory')
  assert.equal(publicConfig.secretConfigured, true)
  assert.equal(publicConfig.health.message, 'Workspace Chart archive is disabled.')
})

test('Chart storage mutations stay inside the handler error boundary', async () => {
  const source = await readFile(new URL('../api/_handlers/chart-storage.js', import.meta.url), 'utf8')
  assert.match(source, /req\.method === 'POST'\) return await testStorage/)
  assert.match(source, /req\.method === 'PUT'\) return await saveStorage/)
  assert.match(source, /return await removeStorage/)
})

test('workspace Chart storage metadata can be displayed without decrypting its secret', () => {
  const record = {
    enabled: true,
    secretConfiguredAt: new Date(),
    dbName: 'workspace_telemetry',
    collectionName: 'chart_samples',
    retentionDays: 45,
    batchSize: 250,
    flushMs: 500,
    maxQueue: 5000,
    maxPoolSize: 12,
    maxBootstrapPoints: 8000,
  }
  const config = workspaceChartStorageMetadataConfig(record)
  assert.equal(config.enabled, true)
  assert.equal(config.uri, '')
  assert.equal(config.dbName, 'workspace_telemetry')
  assert.equal(config.maxPoolSize, 12)
})

test('production web configuration requires credentials, SRV, and an allowlisted host', () => {
  const environment = {
    NODE_ENV: 'production',
    CHART_MONGO_ALLOWED_HOSTS: 'archive.example',
  }
  assert.equal(
    normalizeChartMongoUri('mongodb+srv://writer:secret@archive.example/telemetry', environment),
    'mongodb+srv://writer:secret@archive.example/telemetry',
  )
  assert.throws(
    () => normalizeChartMongoUri('mongodb://writer:secret@archive.example/telemetry', environment),
    error => error.code === 'CHART_STORAGE_TARGET_INVALID',
  )
  assert.throws(
    () => normalizeChartMongoUri('mongodb+srv://archive.example/telemetry', environment),
    error => error.code === 'CHART_STORAGE_TARGET_INVALID',
  )
  assert.throws(
    () => normalizeChartMongoUri('mongodb+srv://writer:secret@other.example/telemetry', environment),
    error => error.code === 'CHART_STORAGE_TARGET_INVALID',
  )
})

test('Chart storage secrets are encrypted and bound to one workspace', () => {
  const previousKey = process.env.SCADA_CONNECTOR_MASTER_KEY
  process.env.SCADA_CONNECTOR_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
  try {
    const uri = 'mongodb+srv://writer:secret@archive.example/telemetry'
    const encrypted = encryptChartStorageSecret({ uri }, { workspaceId: 'workspace-a' })
    assert.equal(JSON.stringify(encrypted).includes(uri), false)
    assert.deepEqual(decryptChartStorageSecret(encrypted, { workspaceId: 'workspace-a' }), { uri })
    assert.throws(
      () => decryptChartStorageSecret(encrypted, { workspaceId: 'workspace-b' }),
      error => error.code === 'CONNECTOR_KEY_MISMATCH',
    )
    const label = chartStorageTargetLabel(uri)
    assert.equal(label.includes('writer'), false)
    assert.equal(label.includes('secret'), false)
  } finally {
    if (previousKey == null) delete process.env.SCADA_CONNECTOR_MASTER_KEY
    else process.env.SCADA_CONNECTOR_MASTER_KEY = previousKey
  }
})

test('Chart samples are numeric, good-quality, and isolated by metadata', () => {
  const sample = normalizeChartTelemetryEvent({
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    sourceId: 'source-a',
    tagId: 'level',
    value: '42.5',
    sourceTimestamp: '2026-07-27T01:00:00.000Z',
    receivedAt: '2026-07-27T01:00:01.000Z',
    quality: 'good',
    sequence: 7,
  })
  assert.deepEqual(sample.meta, { workspaceId: 'workspace-a', projectId: 'project-a', sourceId: 'source-a', tagId: 'level' })
  assert.equal(sample.value, 42.5)
  assert.equal(sample.sequence, 7)
  assert.equal(normalizeChartTelemetryEvent({ ...sample, quality: 'stale' }), null)
  assert.equal(normalizeChartTelemetryEvent({ workspaceId: 'w', projectId: 'p', tagId: 't', value: 'NaN' }), null)
})

test('batch writer bounds memory and preserves the newest archive samples', async () => {
  const batches = []
  const writer = new TelemetryBatchWriter({
    batchSize: 10,
    flushMs: 1000,
    maxQueue: 3,
    writeBatch: async batch => { batches.push(batch); return { inserted: batch.length } },
  })
  for (let value = 0; value < 5; value += 1) writer.enqueue({ value, quality: 'good' })
  assert.equal(writer.stats.dropped, 2)
  await writer.flush()
  assert.deepEqual(batches[0].map(event => event.value), [2, 3, 4])
  assert.equal(writer.stats.written, 3)
  assert.equal(writer.queue.length, 0)
})

test('batch writer requeues failed writes without blocking live ingestion', async () => {
  const writer = new TelemetryBatchWriter({
    batchSize: 10,
    flushMs: 1000,
    maxQueue: 3,
    writeBatch: async () => { throw Object.assign(new Error('offline'), { code: 'OFFLINE' }) },
  })
  writer.enqueue({ value: 1, quality: 'good' })
  await writer.flush()
  assert.equal(writer.stats.failures, 1)
  assert.equal(writer.queue.length, 1)
  assert.equal(writer.enqueue({ value: 2, quality: 'good' }), true)
})

test('runtime Chart history request enforces readable numeric tags and total budget', () => {
  const schema = {
    tags: [
      { id: 'a', dataType: 'number', access: 'read' },
      { id: 'b', dataType: 'number', access: 'read-write' },
      { id: 'write', dataType: 'number', access: 'write' },
      { id: 'text', dataType: 'string', access: 'read' },
    ],
    components: [{
      type: 'chart',
      visible: true,
      binding: { tagIds: ['a', 'b', 'write', 'text'] },
      properties: { historyLimit: 2000, windowMinutes: 120 },
    }],
  }
  const request = runtimeChartHistoryRequest(schema, { now: 1_000_000_000, maxBootstrapPoints: 100 })
  assert.deepEqual(request.tagIds, ['a', 'b'])
  assert.equal(request.limitPerTag, 50)
  assert.equal(request.windowMinutes, 120)
  assert.equal(request.since.getTime(), 1_000_000_000 - 120 * 60_000)
})
