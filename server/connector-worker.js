import 'dotenv/config'
import { connectMongo, mongoConnectionStatus } from '../api/_lib/mongo.js'
import { AuditEvent, ChartStorageConfiguration, ChartStorageSecret, CommandEvent, Connector, ConnectorEnvironment, ConnectorHealthEvent, Project, ProjectDraft, ProjectVersion, RuntimeSession, TagValueSnapshot } from '../api/_lib/models.js'
import { chartStorageSecretId, decryptChartStorageSecret } from '../api/_lib/connector-secrets.js'
import { ConnectorRuntime } from './connectors/connector-runtime.js'
import { createConnectorDriver } from './connectors/driver-registry.js'
import { selectConnectorRuntimeSchema } from './connectors/runtime-schema-selection.js'
import { RuntimeStreamHub } from './connectors/runtime-stream-hub.js'
import { IpcRuntimeEventSink, routeRuntimeControlMessage } from './connectors/runtime-ipc.js'
import { chartStorageConfig, publicChartStorageConfig } from '../shared/chart-storage-config.js'
import { ensureChartTelemetryStore, writeChartTelemetrySamples } from '../api/_lib/chart-telemetry-store.js'
import { TelemetryBatchWriter } from './connectors/telemetry-batch-writer.js'
import { storedChartStorageConfig } from '../api/_lib/chart-storage-configuration.js'
import { isDatabaseUnavailableError } from '../api/_lib/security.js'
import { retryStartup } from './connectors/startup-retry.js'
import { commandAcknowledgment, commandAcknowledgmentTimeout } from '../shared/command-acknowledgment.js'
import { getThingsBoardAccessToken } from '../api/_lib/thingsboard-auth.js'
import { CoalescingBatchWriter } from './connectors/coalescing-batch-writer.js'
import { dispatchRuntimeEvent } from './connectors/runtime-event-dispatch.js'
import { flushPendingTerminalCommandAudits, persistAndPublishTerminalCommand } from './connectors/command-completion.js'
import { createAdaptiveRecoveryScheduler } from './connectors/adaptive-recovery-scheduler.js'
import { createKeyedTaskQueue } from './connectors/keyed-task-queue.js'
import { createWakeablePoller } from './connectors/wakeable-poller.js'
import { createCommandVersionCache } from './connectors/command-version-cache.js'
import { createRpcPerformanceTracker } from './connectors/rpc-performance.js'
import { shouldRunProjectWorker } from '../shared/runtime-worker-mode.js'

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
  const ipcTransport = process.env.CONNECTOR_STREAM_TRANSPORT === 'ipc' && typeof process.send === 'function'
  const commandVersionCache = createCommandVersionCache({
    maxEntries: process.env.CONNECTOR_COMMAND_VERSION_CACHE_MAX_ENTRIES,
    ttlMs: process.env.CONNECTOR_COMMAND_VERSION_CACHE_TTL_MS,
  })
  const rpcPerformance = createRpcPerformanceTracker({
    maxSamples: process.env.CONNECTOR_RPC_METRICS_CAPACITY,
  })
  let commandQueue = null
  const healthProvider = kind => workerHealth(kind, startup, startedAt, environmentRef, {
    queue: commandQueue?.snapshot() || null,
    publishedVersionCache: commandVersionCache.snapshot(),
    performance: rpcPerformance.snapshot(),
  })
  const hub = ipcTransport
    ? new IpcRuntimeEventSink({ healthProvider })
    : new RuntimeStreamHub({
        port: Number(process.env.CONNECTOR_STREAM_PORT || 3002),
        healthProvider,
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
  let lastSnapshotWriterErrorAt = 0
  let lastSnapshotWriterDropAt = 0
  let lastHealthWriterErrorAt = 0
  let lastCommandHealthWriterErrorAt = 0
  let lastTerminalAuditErrorAt = 0
  const reportSnapshotWriterError = (event, details) => {
    const now = Date.now()
    const lastReportedAt = event === 'error' ? lastSnapshotWriterErrorAt : lastSnapshotWriterDropAt
    if (now - lastReportedAt < 10_000) return
    if (event === 'error') lastSnapshotWriterErrorAt = now
    else lastSnapshotWriterDropAt = now
    console.error('[ConnectorWorker] Latest telemetry snapshot persistence degraded', details)
  }
  const snapshotWriter = new CoalescingBatchWriter({
    batchSize: boundedInteger(process.env.CONNECTOR_SNAPSHOT_BATCH_SIZE, 10, 2000, 500),
    flushMs: boundedInteger(process.env.CONNECTOR_SNAPSHOT_FLUSH_MS, 25, 5000, 100),
    maxPending: boundedInteger(process.env.CONNECTOR_SNAPSHOT_MAX_PENDING, 100, 200_000, 20_000),
    keyFor: event => event?.projectId && event?.tagId ? `${event.projectId}:${event.tagId}` : null,
    writeBatch: writeLatestSnapshots,
    onError: (error, stats) => reportSnapshotWriterError('error', { code: error?.code || 'WRITE_FAILED', pending: stats.pending, dropped: stats.dropped }),
    onDrop: stats => reportSnapshotWriterError('drop', { code: 'QUEUE_OVERFLOW', pending: stats.pending, dropped: stats.dropped }),
  })
  const lastEventHealthWriter = new CoalescingBatchWriter({
    batchSize: boundedInteger(process.env.CONNECTOR_HEALTH_BATCH_SIZE, 10, 1000, 100),
    flushMs: boundedInteger(process.env.CONNECTOR_HEALTH_FLUSH_MS, 1000, 30_000, 5000),
    maxPending: boundedInteger(process.env.CONNECTOR_HEALTH_MAX_PENDING, 100, 20_000, 10_000),
    keyFor: value => value?.environmentId,
    writeBatch: writeLastEventHealth,
    onError: (error, stats) => {
      const now = Date.now()
      if (now - lastHealthWriterErrorAt < 10_000) return
      lastHealthWriterErrorAt = now
      console.error('[ConnectorWorker] Connector last-event health persistence delayed', { code: error?.code || 'WRITE_FAILED', pending: stats.pending })
    },
  })
  const commandHealthWriter = new CoalescingBatchWriter({
    batchSize: boundedInteger(process.env.CONNECTOR_COMMAND_HEALTH_BATCH_SIZE, 10, 1000, 100),
    flushMs: boundedInteger(process.env.CONNECTOR_COMMAND_HEALTH_FLUSH_MS, 25, 5000, 100),
    maxPending: boundedInteger(process.env.CONNECTOR_COMMAND_HEALTH_MAX_PENDING, 100, 20_000, 10_000),
    keyFor: value => value?.environmentId,
    writeBatch: writeCommandHealth,
    onError: (error, stats) => {
      const now = Date.now()
      if (now - lastCommandHealthWriterErrorAt < 10_000) return
      lastCommandHealthWriterErrorAt = now
      console.error('[ConnectorWorker] Command health persistence delayed', { code: error?.code || 'WRITE_FAILED', pending: stats.pending })
    },
  })
  snapshotWriter.start()
  lastEventHealthWriter.start()
  commandHealthWriter.start()
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
    const now = new Date()
    const [connectors, activeSessionProjectIds] = await Promise.all([
      Connector.find({ enabled: true }).lean(),
      RuntimeSession.distinct('projectId', { revokedAt: null, expiresAt: { $gt: now } }),
    ])
    const activeProjects = new Set(activeSessionProjectIds.map(String))
    const wanted = new Set()
    for (const connector of connectors) {
      const environment = await ConnectorEnvironment.findOne({ connectorId: connector._id, environmentRef }).lean()
      const project = environment && await Project.findOne({ _id: connector.projectId, workspaceId: connector.workspaceId }).lean()
      const version = project?.activeVersionId && await ProjectVersion.findById(project.activeVersionId).lean()
      let selection = selectConnectorRuntimeSchema({ connector, environmentRef, publishedVersion: version })
      let draft = null
      if (!selection && project) {
        draft = await ProjectDraft.findById(project._id).lean()
        selection = selectConnectorRuntimeSchema({ connector, environmentRef, publishedVersion: version, draft })
      }
      if (!environment?.secretConfiguredAt || !selection) continue
      if (!shouldRunProjectWorker(project, {
        hasActiveSession: activeProjects.has(String(project._id)),
        selectionMode: selection.mode,
        draftUpdatedAt: draft?.updatedAt,
        now: now.getTime(),
      })) continue
      const { source, bindings, mode } = selection
      let authentication
      try {
        authentication = await getThingsBoardAccessToken({ connectorId: connector._id, environmentRef })
      } catch (error) {
        const message = error?.code === 'THINGSBOARD_JWT_EXPIRED'
          ? 'ThingsBoard JWT expired; reconnect the account in Builder.'
          : 'ThingsBoard authentication is unavailable.'
        await ConnectorEnvironment.updateOne({ _id: environment._id }, { $set: { health: { state: 'error', message, checkedAt: new Date() } } })
        continue
      }
      wanted.add(connector._id)
      const fingerprint = `${selection.fingerprint}:${JSON.stringify(environment.config || {})}:${authentication.secretUpdatedAt?.toISOString?.() || authentication.secretUpdatedAt}`
      const existingRuntime = runtimes.get(connector._id)
      if (existingRuntime?.fingerprint === fingerprint) {
        if (environment.health?.state === 'online') await ConnectorEnvironment.updateOne({ _id: environment._id }, { $set: { 'health.checkedAt': new Date() } })
        continue
      }
      if (existingRuntime) { await existingRuntime.stop(); runtimes.delete(connector._id) }
      const runtime = new ConnectorRuntime({
        connector: { ...connector, id: connector._id },
        environment: { ...environment, secret: authentication.secret }, source, bindings,
        driverFactory: () => createConnectorDriver(connector.type),
        onEvent: event => {
          const workspaceArchiveWriter = workspaceTelemetryWriters.get(event.workspaceId)?.writer
          const archiveWriter = workspaceArchiveWriter || (configuredChartWorkspaces.has(event.workspaceId) ? null : environmentTelemetryWriter)
          dispatchRuntimeEvent({ mode, event, environmentId: environment._id, hub, snapshotWriter, archiveWriter, healthWriter: lastEventHealthWriter })
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

  let reloadInFlight = null
  const requestReload = () => {
    if (!reloadInFlight) reloadInFlight = reload().finally(() => { reloadInFlight = null })
    return reloadInFlight
  }
  await requestReload()
  const terminalAuditRecovery = createAdaptiveRecoveryScheduler({
    recover: () => flushPendingTerminalCommandAudits(),
    activeDelayMs: boundedInteger(process.env.CONNECTOR_TERMINAL_AUDIT_ACTIVE_MS, 100, 60_000, 1_000),
    idleDelayMs: boundedInteger(process.env.CONNECTOR_TERMINAL_AUDIT_IDLE_MS, 1_000, 300_000, 30_000),
    onError: error => {
      const now = Date.now()
      if (now - lastTerminalAuditErrorAt >= 10_000) {
        lastTerminalAuditErrorAt = now
        console.error('[ConnectorWorker] terminal audit recovery delayed', { code: error?.code || 'AUDIT_RECOVERY_FAILED' })
      }
    },
  })
  await terminalAuditRecovery.start()
  let lastCommandQueueErrorAt = 0
  commandQueue = createKeyedTaskQueue({
    maxPending: boundedInteger(process.env.CONNECTOR_COMMAND_MAX_PENDING, 20, 2_000, 200),
    onError: (error, stats) => {
      const now = Date.now()
      if (now - lastCommandQueueErrorAt < 10_000) return
      lastCommandQueueErrorAt = now
      console.error('[ConnectorWorker] command execution failed unexpectedly', { code: error?.code || error?.name || 'COMMAND_FAILED', active: stats.active, queued: stats.queued })
    },
  })
  startup.initialized = true
  startup.phase = 'ready'
  const reloadTimer = setInterval(() => requestReload().catch(error => console.error('[ConnectorWorker] reload failed', error.message)), 10_000)
  let lastCommandPollErrorAt = 0
  const commandPoller = createWakeablePoller({
    poll: () => dispatchCommands(runtimes, hub, commandHealthWriter, terminalAuditRecovery, commandQueue, commandVersionCache, rpcPerformance),
    intervalMs: boundedInteger(process.env.CONNECTOR_COMMAND_POLL_MS, 50, 5_000, 250),
    onError: error => {
      const now = Date.now()
      if (now - lastCommandPollErrorAt < 10_000) return
      lastCommandPollErrorAt = now
      console.error('[ConnectorWorker] command poll failed', { code: error?.code || error?.name || 'COMMAND_POLL_FAILED' })
    },
  })
  const onControlMessage = message => routeRuntimeControlMessage(message, {
    onCommandWake: () => commandPoller.request(),
    onWorkerReload: () => requestReload().catch(error => console.error('[ConnectorWorker] reload failed', error.message)),
  })
  if (ipcTransport) process.on('message', onControlMessage)
  await commandPoller.start()
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    if (ipcTransport) process.off('message', onControlMessage)
    clearInterval(reloadTimer)
    await commandPoller.stop()
    const commandQueueStats = await commandQueue.close({
      timeoutMs: boundedInteger(process.env.CONNECTOR_COMMAND_SHUTDOWN_MS, 1_000, 120_000, 35_000),
      cancelPending: true,
    })
    if (commandQueueStats.timedOut) console.error('[ConnectorWorker] command shutdown grace expired; active outcomes remain unverified', { active: commandQueueStats.active })
    await terminalAuditRecovery.stop()
    await Promise.all([...runtimes.values()].map(runtime => runtime.stop()))
    const [snapshotStats, healthStats, commandHealthStats] = await Promise.all([snapshotWriter.close(), lastEventHealthWriter.close(), commandHealthWriter.close()])
    console.log('[ConnectorWorker] Deferred persistence stopped', { snapshots: snapshotStats, health: healthStats, commandHealth: commandHealthStats, commands: commandQueueStats })
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
  console.log(ipcTransport
    ? `[ConnectorWorker] connected to the Express runtime stream over private IPC for ${environmentRef}`
    : `[ConnectorWorker] listening on :${process.env.CONNECTOR_STREAM_PORT || 3002} for ${environmentRef}`)
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

function workerHealth(kind, startup, startedAt, environmentRef, rpc = {}) {
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
    rpc,
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

async function writeLatestSnapshots(events) {
  if (!events.length) return { written: 0 }
  await TagValueSnapshot.bulkWrite(events.map(event => ({
    updateOne: {
      filter: { _id: `${event.projectId}:${event.tagId}` },
      update: { $set: { ...event, sourceTimestamp: new Date(event.sourceTimestamp), receivedAt: new Date(event.receivedAt) } },
      upsert: true,
      setDefaultsOnInsert: true,
    },
  })), { ordered: false })
  return { written: events.length }
}

async function writeLastEventHealth(entries) {
  if (!entries.length) return { written: 0 }
  await ConnectorEnvironment.bulkWrite(entries.map(entry => ({
    updateOne: {
      filter: { _id: entry.environmentId },
      update: { $max: { 'health.lastEventAt': new Date(entry.receivedAt) } },
    },
  })), { ordered: false })
  return { written: entries.length }
}

async function writeCommandHealth(entries) {
  if (!entries.length) return { written: 0 }
  await ConnectorEnvironment.bulkWrite(entries.map(entry => ({
    updateOne: {
      filter: { _id: entry.environmentId },
      update: { $set: entry.fields },
    },
  })), { ordered: false })
  return { written: entries.length }
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

async function dispatchCommands(runtimes, hub, commandHealthWriter, terminalAuditRecovery, commandQueue, commandVersionCache, rpcPerformance) {
  const pendingIds = commandQueue.pendingIds()
  const filter = { status: 'authorized', executionMode: 'worker' }
  if (pendingIds.length) filter._id = { $nin: pendingIds }
  const queueStats = commandQueue.snapshot()
  const available = Math.min(20, Math.max(0, queueStats.capacity - queueStats.pending))
  if (!available) return 0
  const candidates = await CommandEvent.find(filter).sort({ createdAt: 1 }).limit(available).lean()
  const versionIds = [...new Set(candidates.map(candidate => candidate.versionId).filter(Boolean))]
  const versionsById = await commandVersionCache.load(
    versionIds,
    ids => ProjectVersion.find({ _id: { $in: ids } }).lean(),
  )
  let scheduled = 0
  for (const candidate of candidates) {
    const version = versionsById.get(String(candidate.versionId))
    const tag = version?.schema?.tags?.find(item => item.id === candidate.tagId)
    const source = tag && version.schema.dataSources?.find(item => item.id === tag.sourceId)
    const connectorKey = source?.connectorRef || `unresolved:${candidate.projectId}`
    const accepted = commandQueue.enqueue(connectorKey, () => claimAndExecuteCommand({
      candidate,
      version,
      runtimes,
      hub,
      commandHealthWriter,
      terminalAuditRecovery,
      rpcPerformance,
    }), { id: candidate._id })
    if (accepted) scheduled += 1
  }
  return scheduled
}

async function claimAndExecuteCommand({ candidate, version, runtimes, hub, commandHealthWriter, terminalAuditRecovery, rpcPerformance }) {
  const claimed = await CommandEvent.findOneAndUpdate({ _id: candidate._id, status: 'authorized', executionMode: 'worker' }, { $set: { status: 'dispatched', dispatchedAt: new Date() } }, { new: true }).lean()
  if (!claimed) return
  hub.publishCommand(claimed)
  const tag = version?.schema?.tags?.find(item => item.id === claimed.tagId)
  const component = version?.schema?.components?.find(item => item.id === claimed.componentId)
  const source = tag && version.schema.dataSources?.find(item => item.id === tag.sourceId)
  const runtime = source && runtimes.get(source.connectorRef)
  if (!runtime || runtime.mode !== 'published' || !component || !tag) {
    await finishCommand(hub, claimed, 'failed', 'Published connector runtime is unavailable.', {}, {}, terminalAuditRecovery, rpcPerformance)
    return
  }
  const acknowledgment = commandAcknowledgment(component, runtime.environment.config, claimed.payloadSummary?.value)
  if (!acknowledgment) {
    await finishCommand(hub, claimed, 'failed', 'Command acknowledgment is not configured.', {}, {}, terminalAuditRecovery, rpcPerformance)
    return
  }
  const executionTiming = {
    acknowledgmentMode: acknowledgment.mode,
    upstreamStartedAt: new Date(),
    gatewayAcceptedAt: null,
    upstreamCompletedAt: null,
  }
  try {
    const receipt = await runtime.write({ method: component.properties?.rpcMethod || component.properties?.action || 'setValue', params: claimed.payloadSummary?.value, timeoutMs: acknowledgment.timeoutMs, acknowledgment }, async gatewayReceipt => {
      executionTiming.gatewayAcceptedAt = new Date()
      queueCommandHealth(commandHealthWriter, runtime, 'waiting', 'Waiting for process feedback.')
      const accepted = await CommandEvent.findOneAndUpdate({ _id: claimed._id, status: 'dispatched' }, { $set: { status: 'accepted_by_gateway', resultSummary: { message: 'Accepted by ThingsBoard gateway.', receipt: gatewayReceipt.code } } }, { new: true }).lean()
      if (accepted) hub.publishCommand(accepted)
      await AuditEvent.create({ workspaceId: claimed.workspaceId, projectId: claimed.projectId, actorId: claimed.actorId, action: 'command.accepted_by_gateway', targetType: 'component', targetId: claimed.componentId, correlationId: claimed.correlationId, metadata: { requestId: claimed.requestId, tagId: claimed.tagId } })
    })
    executionTiming.upstreamCompletedAt = new Date()
    if (receipt.rejected) {
      await finishCommand(hub, claimed, 'rejected', 'Device rejected the command.', { code: receipt.code, deviceResult: receipt.result }, executionTiming, terminalAuditRecovery, rpcPerformance)
      queueCommandHealth(commandHealthWriter, runtime, 'online', 'Device RPC responder returned a rejection.', { lastAcknowledgedAt: new Date() })
    } else if (!receipt.accepted) {
      await finishCommand(hub, claimed, 'failed', 'ThingsBoard rejected the RPC.', { code: receipt.code }, executionTiming, terminalAuditRecovery, rpcPerformance)
      queueCommandHealth(commandHealthWriter, runtime, 'degraded', 'ThingsBoard rejected the RPC dispatch.')
    } else if (receipt.acknowledged) {
      await finishCommand(hub, claimed, 'acknowledged', 'Command acknowledged.', { value: claimed.payloadSummary?.value, receipt: receipt.code }, executionTiming, terminalAuditRecovery, rpcPerformance)
      queueCommandHealth(commandHealthWriter, runtime, 'online', acknowledgment.mode === 'two-way' ? 'Device RPC responder acknowledged the command.' : 'Process feedback matched the command.', { lastAcknowledgedAt: new Date() })
    } else {
      const timeout = commandAcknowledgmentTimeout(acknowledgment.mode, receipt.code)
      await finishCommand(hub, claimed, timeout.command.status, timeout.command.message, timeout.command.result, executionTiming, terminalAuditRecovery, rpcPerformance)
      queueCommandHealth(commandHealthWriter, runtime, timeout.commandHealth.state, timeout.commandHealth.message, { lastTimeoutAt: new Date() })
    }
  } catch (error) {
    executionTiming.upstreamCompletedAt ||= new Date()
    if (error?.name === 'TimeoutError') {
      const timeout = commandAcknowledgmentTimeout(acknowledgment.mode)
      await finishCommand(hub, claimed, timeout.command.status, timeout.command.message, timeout.command.result, executionTiming, terminalAuditRecovery, rpcPerformance)
      queueCommandHealth(commandHealthWriter, runtime, timeout.commandHealth.state, timeout.commandHealth.message, { lastTimeoutAt: new Date() })
    } else {
      await finishCommand(hub, claimed, 'failed', 'Command dispatch failed.', {}, executionTiming, terminalAuditRecovery, rpcPerformance)
      queueCommandHealth(commandHealthWriter, runtime, 'degraded', 'RPC dispatch failed.')
    }
  }
}

async function finishCommand(hub, event, status, message, result = {}, timing = {}, terminalAuditRecovery, rpcPerformance) {
  const completed = await persistAndPublishTerminalCommand({
    hub,
    event,
    status,
    message,
    result,
    timing,
    onAuditDeferred: () => terminalAuditRecovery?.request(),
  })
  rpcPerformance?.record(completed)
  return completed
}

function queueCommandHealth(writer, runtime, state, message, timestamps = {}) {
  const environmentId = runtime?.environment?._id
  if (!environmentId) return false
  const checkedAt = new Date()
  const fields = {
    'commandHealth.state': state,
    'commandHealth.message': message,
    'commandHealth.checkedAt': checkedAt,
  }
  if (timestamps.lastAcknowledgedAt) fields['commandHealth.lastAcknowledgedAt'] = timestamps.lastAcknowledgedAt
  if (timestamps.lastTimeoutAt) fields['commandHealth.lastTimeoutAt'] = timestamps.lastTimeoutAt
  return writer.enqueue({ environmentId, fields })
}
