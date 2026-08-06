import 'dotenv/config'
import { connectMongo, mongoConnectionStatus } from '../api/_lib/mongo.js'
import { AuditEvent, ChartStorageConfiguration, ChartStorageSecret, CommandEvent, Connector, ConnectorEnvironment, ConnectorHealthEvent, ConnectorSecret, Project, ProjectDraft, ProjectVersion, TagValueSnapshot } from '../api/_lib/models.js'
import { chartStorageSecretId, connectorSecretId, decryptChartStorageSecret, decryptConnectorSecret } from '../api/_lib/connector-secrets.js'
import { ConnectorRuntime } from './connectors/connector-runtime.js'
import { createConnectorDriver } from './connectors/driver-registry.js'
import { selectConnectorRuntimeSchema } from './connectors/runtime-schema-selection.js'
import { RuntimeStreamHub } from './connectors/runtime-stream-hub.js'
import { chartStorageConfig, publicChartStorageConfig } from '../shared/chart-storage-config.js'
import { ensureChartTelemetryStore, writeChartTelemetrySamples } from '../api/_lib/chart-telemetry-store.js'
import { TelemetryBatchWriter } from './connectors/telemetry-batch-writer.js'
import { storedChartStorageConfig } from '../api/_lib/chart-storage-configuration.js'
import { isDatabaseUnavailableError } from '../api/_lib/security.js'
import { retryStartup } from './connectors/startup-retry.js'
import { commandAcknowledgment, commandAcknowledgmentTimeout } from '../shared/command-acknowledgment.js'

if (process.env.CONNECTOR_PLATFORM_ENABLED !== 'true') {
  console.error('[ConnectorWorker] CONNECTOR_PLATFORM_ENABLED is not true; refusing to start.')
  process.exitCode = 1
} else {
  await main().catch(error => {
    console.error('[ConnectorWorker] startup failed', { code: String(error?.code || error?.name || 'STARTUP_FAILED').slice(0, 80) })
    process.exitCode = 1
  })
}

async function main() {
  const environmentRef = process.env.CONNECTOR_ENVIRONMENT || 'staging'
  const startedAt = Date.now()
  const startup = { initialized: false, phase: 'starting', attempts: 0 }
  const hub = new RuntimeStreamHub({
    port: Number(process.env.CONNECTOR_STREAM_PORT || 3002),
    healthProvider: kind => workerHealth(kind, startup, startedAt, environmentRef),
  })
  await hub.ready()
  try {
    startup.phase = 'connecting-mongodb'
    await retryStartup(() => connectMongo(), {
      maxAttempts: nonNegativeInteger(process.env.CONNECTOR_MONGO_STARTUP_MAX_ATTEMPTS, 0),
      initialDelayMs: positiveInteger(process.env.CONNECTOR_MONGO_RETRY_INITIAL_MS, 500),
      maxDelayMs: positiveInteger(process.env.CONNECTOR_MONGO_RETRY_MAX_MS, 10_000),
      shouldRetry: isDatabaseUnavailableError,
      onRetry: ({ attempt, delayMs, error }) => {
        startup.attempts = attempt
        startup.phase = 'retrying-mongodb'
        console.error('[ConnectorWorker] MongoDB startup connection unavailable; retry scheduled', {
          attempt,
          delayMs,
          code: String(error?.code || error?.name || 'DATABASE_UNAVAILABLE').slice(0, 80),
        })
      },
    })
    startup.phase = 'initializing'
    await migrateLegacyCommandHealth(environmentRef)
  } catch (error) {
    startup.phase = 'failed'
    await hub.close()
    throw error
  }
  const runtimes = new Map()
  const healthSummaries = new Map()
  const chartConfig = chartStorageConfig()
  let lastChartStoreErrorAt = 0
  const environmentTelemetryWriter = chartConfig.enabled
    ? new TelemetryBatchWriter({
        batchSize: chartConfig.batchSize,
        flushMs: chartConfig.flushMs,
        maxQueue: chartConfig.maxQueue,
        writeBatch: writeChartTelemetrySamples,
        onError: (error, stats) => {
          const now = Date.now()
          if (now - lastChartStoreErrorAt < 10_000) return
          lastChartStoreErrorAt = now
          console.error('[ConnectorWorker] Chart telemetry archive degraded', { code: error?.code || 'WRITE_FAILED', pending: stats.pending, dropped: stats.dropped })
        },
      })
    : null
  if (environmentTelemetryWriter) {
    environmentTelemetryWriter.start()
    await ensureChartTelemetryStore()
      .then(() => console.log('[ConnectorWorker] Chart telemetry archive ready', publicChartStorageConfig(chartConfig)))
      .catch(error => console.error('[ConnectorWorker] Chart telemetry archive unavailable; live streaming remains active', { code: error?.code || 'CONNECTION_FAILED' }))
  } else {
    console.log('[ConnectorWorker] Chart telemetry archive disabled; runtime will keep session-only history.')
  }
  const workspaceTelemetryWriters = new Map()
  const configuredChartWorkspaces = new Set()

  const reloadWorkspaceChartWriters = async () => {
    const allRecords = await ChartStorageConfiguration.find({}).lean()
    configuredChartWorkspaces.clear()
    allRecords.forEach(record => configuredChartWorkspaces.add(record.workspaceId))
    const records = allRecords.filter(record => record.enabled && record.secretConfiguredAt)
    const wanted = new Set()
    for (const record of records) {
      const secretRecord = await ChartStorageSecret.findById(chartStorageSecretId(record.workspaceId))
        .select('+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion')
        .lean()
      if (!secretRecord) continue
      wanted.add(record.workspaceId)
      try {
        const { uri } = decryptChartStorageSecret(secretRecord, { workspaceId: record.workspaceId })
        const config = storedChartStorageConfig(record, uri)
        const fingerprint = `${record.updatedAt?.toISOString?.() || record.updatedAt}:${secretRecord.updatedAt?.toISOString?.() || secretRecord.updatedAt}`
        const existing = workspaceTelemetryWriters.get(record.workspaceId)
        if (existing?.fingerprint === fingerprint) continue
        if (existing) await existing.writer.close()
        await ensureChartTelemetryStore({ config })
        let lastHealthWriteAt = 0
        const updateStorageHealth = (state, message) => {
          const now = Date.now()
          if (now - lastHealthWriteAt < 10_000) return
          lastHealthWriteAt = now
          ChartStorageConfiguration.updateOne({ workspaceId: record.workspaceId }, { $set: { health: { state, message, checkedAt: new Date(now) } } }).catch(() => {})
        }
        const writer = new TelemetryBatchWriter({
          batchSize: config.batchSize,
          flushMs: config.flushMs,
          maxQueue: config.maxQueue,
          writeBatch: batch => writeChartTelemetrySamples(batch, { config }),
          onError: (error, stats) => {
            updateStorageHealth('degraded', `Archive write delayed; ${stats.pending} samples queued.`)
            console.error('[ConnectorWorker] Workspace Chart archive degraded', { workspaceId: record.workspaceId, code: error?.code || 'WRITE_FAILED', pending: stats.pending, dropped: stats.dropped })
          },
          onSuccess: () => updateStorageHealth('ready', 'MongoDB time-series storage is ready.'),
        })
        writer.start()
        workspaceTelemetryWriters.set(record.workspaceId, { fingerprint, writer })
        await ChartStorageConfiguration.updateOne({ workspaceId: record.workspaceId }, { $set: { health: { state: 'ready', message: 'MongoDB time-series storage is ready.', checkedAt: new Date() } } })
      } catch (error) {
        const existing = workspaceTelemetryWriters.get(record.workspaceId)
        if (existing) { await existing.writer.close(); workspaceTelemetryWriters.delete(record.workspaceId) }
        await ChartStorageConfiguration.updateOne({ workspaceId: record.workspaceId }, { $set: { health: { state: 'error', message: 'Worker could not activate MongoDB Chart storage.', checkedAt: new Date() } } })
        console.error('[ConnectorWorker] Workspace Chart archive configuration failed', { workspaceId: record.workspaceId, code: error?.code || 'CONFIGURATION_FAILED' })
      }
    }
    for (const [workspaceId, entry] of workspaceTelemetryWriters) {
      if (wanted.has(workspaceId)) continue
      await entry.writer.close()
      workspaceTelemetryWriters.delete(workspaceId)
    }
  }

  const reload = async () => {
    await connectMongo()
    await reloadWorkspaceChartWriters()
    const connectors = await Connector.find({ enabled: true }).lean()
    const wanted = new Set()
    for (const connector of connectors) {
      const environment = await ConnectorEnvironment.findOne({ connectorId: connector._id, environmentRef }).lean()
      const secretRecord = environment?.secretConfiguredAt && await ConnectorSecret.findById(connectorSecretId(connector._id, environmentRef)).select('+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion').lean()
      const project = environment && await Project.findOne({ _id: connector.projectId, workspaceId: connector.workspaceId }).lean()
      const version = project?.activeVersionId && await ProjectVersion.findById(project.activeVersionId).lean()
      let selection = selectConnectorRuntimeSchema({ connector, environmentRef, publishedVersion: version })
      if (!selection && project) {
        const draft = await ProjectDraft.findById(project._id).lean()
        selection = selectConnectorRuntimeSchema({ connector, environmentRef, publishedVersion: version, draft })
      }
      if (!environment || !secretRecord || !selection) continue
      const { source, bindings, mode } = selection
      wanted.add(connector._id)
      const fingerprint = `${selection.fingerprint}:${JSON.stringify(environment.config || {})}:${secretRecord.updatedAt?.toISOString?.() || secretRecord.updatedAt}`
      const existingRuntime = runtimes.get(connector._id)
      if (existingRuntime?.fingerprint === fingerprint) {
        if (environment.health?.state === 'online') await ConnectorEnvironment.updateOne({ _id: environment._id }, { $set: { 'health.checkedAt': new Date() } })
        continue
      }
      if (existingRuntime) { await existingRuntime.stop(); runtimes.delete(connector._id) }
      const secret = decryptConnectorSecret(secretRecord, { connectorId: connector._id, environmentRef })
      const runtime = new ConnectorRuntime({
        connector: { ...connector, id: connector._id },
        environment: { ...environment, secret }, source, bindings,
        driverFactory: () => createConnectorDriver(connector.type),
        onEvent: async event => {
          if (mode === 'bootstrap') return
          await TagValueSnapshot.findOneAndUpdate({ _id: `${event.projectId}:${event.tagId}` }, { $set: { ...event, sourceTimestamp: new Date(event.sourceTimestamp), receivedAt: new Date(event.receivedAt) } }, { upsert: true, setDefaultsOnInsert: true })
          hub.publish(event)
          const workspaceArchiveWriter = workspaceTelemetryWriters.get(event.workspaceId)?.writer
          const archiveWriter = workspaceArchiveWriter || (configuredChartWorkspaces.has(event.workspaceId) ? null : environmentTelemetryWriter)
          archiveWriter?.enqueue(event)
          await ConnectorEnvironment.updateOne({ _id: environment._id }, { $set: { 'health.lastEventAt': new Date(event.receivedAt) } })
        },
        onHealth: async (state, message) => {
          const now = new Date()
          const healthMessage = mode === 'bootstrap' ? `Draft bootstrap: ${message}` : message
          const healthSummary = `${state}:${healthMessage}`
          if (healthSummaries.get(connector._id) !== healthSummary) {
            const connectorName = String(connector.name || connector._id).replace(/[\r\n]+/g, ' ')
            console.log(`[ConnectorWorker] ${connectorName} ${state}: ${healthMessage}`)
            healthSummaries.set(connector._id, healthSummary)
          }
          await ConnectorEnvironment.updateOne({ _id: environment._id }, { $set: { health: { state, message: healthMessage, checkedAt: now, ...(state === 'online' ? { connectedAt: now } : {}) } } })
          await ConnectorHealthEvent.create({ connectorId: connector._id, workspaceId: connector.workspaceId, projectId: connector.projectId, environmentRef, state, message: healthMessage })
        },
      })
      runtime.fingerprint = fingerprint
      runtime.mode = mode
      runtimes.set(connector._id, runtime)
      runtime.start().catch(error => console.error('[ConnectorWorker] runtime stopped', connector._id, error.message))
    }
    for (const [id, runtime] of runtimes) if (!wanted.has(id)) { await runtime.stop(); runtimes.delete(id); healthSummaries.delete(id) }
  }

  await reload()
  startup.initialized = true
  startup.phase = 'ready'
  const reloadTimer = setInterval(() => reload().catch(error => console.error('[ConnectorWorker] reload failed', error.message)), 10_000)
  const commandTimer = setInterval(() => dispatchCommands(runtimes).catch(error => console.error('[ConnectorWorker] command poll failed', error.message)), 250)
  const shutdown = async () => {
    clearInterval(reloadTimer); clearInterval(commandTimer)
    await Promise.all([...runtimes.values()].map(runtime => runtime.stop()))
    if (environmentTelemetryWriter) {
      const writerStats = await environmentTelemetryWriter.close()
      console.log('[ConnectorWorker] Chart telemetry archive stopped', writerStats)
    }
    await Promise.all([...workspaceTelemetryWriters.values()].map(entry => entry.writer.close()))
    startup.initialized = false
    startup.phase = 'stopping'
    await hub.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.log(`[ConnectorWorker] listening on :${process.env.CONNECTOR_STREAM_PORT || 3002} for ${environmentRef}`)
}

async function migrateLegacyCommandHealth(environmentRef) {
  await ConnectorEnvironment.updateMany(
    { environmentRef, 'commandHealth.state': 'offline' },
    {
      $set: {
        'commandHealth.state': 'unverified',
        'commandHealth.message': 'Legacy RPC timeout; command outcome is unverified.',
        'commandHealth.checkedAt': new Date(),
      },
    },
  )
}

function workerHealth(kind, startup, startedAt, environmentRef) {
  const mongo = mongoConnectionStatus()
  const ready = startup.initialized && mongo.ready
  return {
    ok: kind === 'liveness' ? true : ready,
    status: kind === 'liveness' ? 'alive' : ready ? 'ready' : 'not-ready',
    environment: environmentRef,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    checks: {
      initialization: startup.phase,
      mongo: mongo.state,
    },
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

async function dispatchCommands(runtimes) {
  const candidates = await CommandEvent.find({ status: 'authorized', executionMode: { $ne: 'serverless' } }).sort({ createdAt: 1 }).limit(20).lean()
  for (const candidate of candidates) {
    const claimed = await CommandEvent.findOneAndUpdate({ _id: candidate._id, status: 'authorized' }, { $set: { status: 'dispatched' } }, { new: true }).lean()
    if (!claimed) continue
    const version = await ProjectVersion.findById(claimed.versionId).lean()
    const tag = version?.schema?.tags?.find(item => item.id === claimed.tagId)
    const component = version?.schema?.components?.find(item => item.id === claimed.componentId)
    const source = tag && version.schema.dataSources?.find(item => item.id === tag.sourceId)
    const runtime = source && runtimes.get(source.connectorRef)
    if (!runtime || runtime.mode !== 'published' || !component || !tag) { await finishCommand(claimed, 'failed', 'Published connector runtime is unavailable.'); continue }
    const acknowledgment = commandAcknowledgment(component, runtime.environment.config, claimed.payloadSummary?.value)
    if (!acknowledgment) { await finishCommand(claimed, 'failed', 'Command acknowledgment is not configured.'); continue }
    try {
      const receipt = await runtime.write({ method: component.properties?.rpcMethod || component.properties?.action || 'setValue', params: claimed.payloadSummary?.value, timeoutMs: acknowledgment.timeoutMs, acknowledgment }, async gatewayReceipt => {
        await updateCommandHealth(runtime, 'waiting', acknowledgment.mode === 'two-way' ? 'Waiting for device RPC response.' : 'Waiting for process feedback.')
        await CommandEvent.updateOne({ _id: claimed._id, status: 'dispatched' }, { $set: { status: 'accepted_by_gateway', resultSummary: { message: 'Accepted by ThingsBoard gateway.', receipt: gatewayReceipt.code } } })
        await AuditEvent.create({ workspaceId: claimed.workspaceId, projectId: claimed.projectId, actorId: claimed.actorId, action: 'command.accepted_by_gateway', targetType: 'component', targetId: claimed.componentId, correlationId: claimed.correlationId, metadata: { requestId: claimed.requestId, tagId: claimed.tagId } })
      })
      if (receipt.rejected) {
        await updateCommandHealth(runtime, 'online', 'Device RPC responder returned a rejection.', { lastAcknowledgedAt: new Date() })
        await finishCommand(claimed, 'rejected', 'Device rejected the command.', { code: receipt.code, deviceResult: receipt.result })
      } else if (!receipt.accepted) {
        await updateCommandHealth(runtime, 'degraded', 'ThingsBoard rejected the RPC dispatch.')
        await finishCommand(claimed, 'failed', 'ThingsBoard rejected the RPC.', { code: receipt.code })
      } else if (receipt.acknowledged) {
        await updateCommandHealth(runtime, 'online', acknowledgment.mode === 'two-way' ? 'Device RPC responder acknowledged the command.' : 'Process feedback matched the command.', { lastAcknowledgedAt: new Date() })
        await finishCommand(claimed, 'acknowledged', 'Command acknowledged.', { value: claimed.payloadSummary?.value, receipt: receipt.code })
      } else {
        const timeout = commandAcknowledgmentTimeout(acknowledgment.mode, receipt.code)
        await updateCommandHealth(runtime, timeout.commandHealth.state, timeout.commandHealth.message, { lastTimeoutAt: new Date() })
        await finishCommand(claimed, timeout.command.status, timeout.command.message, timeout.command.result)
      }
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        const timeout = commandAcknowledgmentTimeout(acknowledgment.mode)
        await updateCommandHealth(runtime, timeout.commandHealth.state, timeout.commandHealth.message, { lastTimeoutAt: new Date() })
        await finishCommand(claimed, timeout.command.status, timeout.command.message, timeout.command.result)
      } else {
        await updateCommandHealth(runtime, 'degraded', 'RPC dispatch failed.')
        await finishCommand(claimed, 'failed', 'Command dispatch failed.')
      }
    }
  }
}

async function finishCommand(event, status, message, result = {}) {
  await CommandEvent.updateOne({ _id: event._id }, { $set: { status, resultSummary: { ...result, message }, completedAt: new Date() } })
  await AuditEvent.create({ workspaceId: event.workspaceId, projectId: event.projectId, actorId: event.actorId, action: `command.${status}`, targetType: 'component', targetId: event.componentId, correlationId: event.correlationId, metadata: { requestId: event.requestId, tagId: event.tagId, result: status } })
}

async function updateCommandHealth(runtime, state, message, timestamps = {}) {
  const environmentId = runtime?.environment?._id
  if (!environmentId) return
  const checkedAt = new Date()
  const fields = {
    'commandHealth.state': state,
    'commandHealth.message': message,
    'commandHealth.checkedAt': checkedAt,
  }
  if (timestamps.lastAcknowledgedAt) fields['commandHealth.lastAcknowledgedAt'] = timestamps.lastAcknowledgedAt
  if (timestamps.lastTimeoutAt) fields['commandHealth.lastTimeoutAt'] = timestamps.lastTimeoutAt
  await ConnectorEnvironment.updateOne({ _id: environmentId }, { $set: fields })
}
