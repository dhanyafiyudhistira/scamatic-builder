import { createHash } from 'node:crypto'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { connectMongo } from '../_lib/mongo.js'
import { Connector, ConnectorEnvironment, ConnectorSecret, Project, ProjectVersion, RuntimeSession, TagValueSnapshot } from '../_lib/models.js'
import { connectorSecretId, decryptConnectorSecret } from '../_lib/connector-secrets.js'
import { enforceRateLimit, requestId } from '../_lib/security.js'
import {
  acquireSimulationResponderLease,
  advanceSimulationRpcStage,
  claimSimulationRpcStage,
  findPendingSimulationRpc,
  recordSimulationRpc,
  releaseSimulationResponderLease,
  releaseSimulationRpcStage,
  simulationResponderKey,
  storeSimulationRpcCompletion,
  takeoverSimulationResponderLease,
} from '../_lib/simulation-rpc-state.js'
import { pollDeviceRpc, publishDeviceTelemetry, respondDeviceRpc, timestampedDeviceTelemetry } from '../_lib/thingsboard-device.js'
import { runtimeProfile } from '../../shared/runtime-profile.js'
import { simulationTelemetryPayload } from '../../shared/simulation-bridge.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  if (req.method === 'POST' && !requireCsrf(req, res, principal)) return
  const projectId = String(req.query?.projectId || req.body?.projectId || '')
  const runtimeToken = String(req.headers?.['x-runtime-token'] || '')
  const correlationId = requestId(req)
  if (!projectId || !runtimeToken) return res.status(400).json({ error: 'projectId and X-Runtime-Token are required.', code: 'SIMULATION_BRIDGE_INPUT_INVALID', correlationId })
  const requestedAction = req.method === 'GET' ? 'poll' : String(req.body?.action || '')
  const rateScope = ['poll', 'telemetry', 'respond', 'acknowledge', 'takeover', 'release'].includes(requestedAction) ? requestedAction : 'invalid'
  const rateLimit = rateScope === 'telemetry' ? 360 : rateScope === 'poll' ? 30 : 120
  if (!(await enforceRateLimit(req, res, `simulation-bridge-${rateScope}`, { limit: rateLimit, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return

  try {
    const startedAt = Date.now()
    await connectMongo()
    const project = await Project.findById(projectId)
    const authorization = project && await requireProjectPermission(principal, res, project, PERMISSIONS.COMMAND_EXECUTE)
    if (!authorization) return
    const runtimeSession = await RuntimeSession.findOne({
      _id: digest(runtimeToken),
      authSessionId: principal.sessionId,
      userId: principal.id,
      projectId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).lean()
    if (!runtimeSession || runtimeSession.versionId !== project.activeVersionId || !runtimeSession.capabilities.includes(PERMISSIONS.COMMAND_EXECUTE)) {
      return res.status(403).json({ error: 'Runtime session is invalid or cannot operate Simulation Bridge.', code: 'RUNTIME_SESSION_INVALID', correlationId })
    }
    const version = await ProjectVersion.findById(project.activeVersionId).lean()
    if (!version || runtimeProfile(version.schema) !== 'simulation') {
      return res.status(409).json({ error: 'Simulation Bridge is available only for the Simulation runtime profile.', code: 'SIMULATION_PROFILE_REQUIRED', correlationId })
    }
    const bridge = await loadBridge({ version, project, principal })
    const transport = { serverUrl: bridge.environment.config.serverUrl, deviceToken: bridge.deviceToken }
    const responderKey = simulationResponderKey(transport.serverUrl, transport.deviceToken)
    if (requestedAction === 'release') {
      const release = await releaseSimulationResponderLease({ responderKey, runtimeSessionId: String(runtimeSession._id) })
      return res.status(200).json({ ok: true, ...release, correlationId })
    }
    if (requestedAction === 'takeover') {
      const lease = await takeoverSimulationResponderLease({
        responderKey,
        projectId,
        versionId: String(project.activeVersionId),
        runtimeSessionId: String(runtimeSession._id),
        responderId: runtimeSession.responderId || String(runtimeSession._id),
        responderGeneration: runtimeSession.responderGeneration || 1,
      })
      return res.status(200).json({ ok: true, lease, correlationId })
    }
    const lease = await acquireSimulationResponderLease({
      responderKey,
      projectId,
      versionId: String(project.activeVersionId),
      runtimeSessionId: String(runtimeSession._id),
      responderId: runtimeSession.responderId || String(runtimeSession._id),
      responderGeneration: runtimeSession.responderGeneration || 1,
    })
    if (!lease.active) {
      if (req.method === 'GET') return res.status(200).json({ request: null, lease, correlationId })
      return res.status(409).json({
        error: 'Another runtime session owns the Simulation RPC responder lease.',
        code: 'SIMULATION_RESPONDER_STANDBY',
        retryAfterMs: lease.retryAfterMs,
        expiresAt: lease.expiresAt,
        correlationId,
      })
    }
    const lifecycleContext = {
      projectId,
      versionId: String(project.activeVersionId),
      runtimeSessionId: String(runtimeSession._id),
    }

    if (req.method === 'GET') {
      let pending = await findPendingSimulationRpc(lifecycleContext)
      if (pending?.status === 'telemetry_published') {
        await completeRpcLifecycle(pending, lifecycleContext.runtimeSessionId, transport)
        pending = await findPendingSimulationRpc(lifecycleContext)
      }
      if (pending?.status === 'received') {
        return res.status(200).json({ request: pending.request, lifecycle: pending.status, lease, correlationId })
      }
      const rpc = await pollDeviceRpc(transport)
      if (!rpc) return res.status(200).json({ request: null, lease, correlationId })
      const lifecycle = await recordSimulationRpc({ ...lifecycleContext, request: rpc })
      if (lifecycle.status === 'telemetry_published') {
        await completeRpcLifecycle(lifecycle, lifecycleContext.runtimeSessionId, transport)
        return res.status(200).json({ request: null, lifecycle: 'responded', lease, correlationId })
      }
      return res.status(200).json({
        request: lifecycle.status === 'received' ? lifecycle.request : null,
        lifecycle: lifecycle.status,
        lease,
        correlationId,
      })
    }
    const action = requestedAction
    if (action === 'telemetry') {
      const heartbeat = req.body?.heartbeat === true
      const values = simulationTelemetryPayload(version.schema, req.body?.values || {}, { allowEmpty: heartbeat })
      if (heartbeat && !Object.keys(values).length) values.SimulationBridgeHeartbeat = true
      const timestamp = Number(req.body?.timestamp ?? Date.now())
      await publishDeviceTelemetry({ ...transport, values: timestampedDeviceTelemetry(values, timestamp) })
      await persistSimulationSnapshots({
        schema: version.schema,
        telemetryValues: values,
        workspaceId: principal.workspaceId,
        projectId,
        timestamp,
      })
      return res.status(200).json({ ok: true, heartbeat, published: Object.keys(values).length, durationMs: Date.now() - startedAt, correlationId })
    }
    if (['respond', 'acknowledge'].includes(action)) {
      const values = action === 'acknowledge'
        ? simulationTelemetryPayload(version.schema, req.body?.values || {}, { allowEmpty: true })
        : {}
      let lifecycle = await storeSimulationRpcCompletion({
        ...lifecycleContext,
        requestId: req.body?.requestId,
        responsePayload: req.body?.payload,
        telemetryPayload: values,
        telemetryTimestamp: req.body?.timestamp ?? Date.now(),
        publishTelemetry: action === 'acknowledge' && Object.keys(values).length > 0,
      })
      if (!lifecycle) lifecycle = await findPendingSimulationRpc(lifecycleContext)
      const replayed = lifecycle?.status === 'responded'
      lifecycle = await completeRpcLifecycle(lifecycle, lifecycleContext.runtimeSessionId, transport)
      if (action === 'acknowledge' && lifecycle.status === 'responded') {
        await persistSimulationSnapshots({
          schema: version.schema,
          telemetryValues: values,
          workspaceId: principal.workspaceId,
          projectId,
          timestamp: Number(req.body?.timestamp ?? Date.now()),
        })
      }
      return res.status(200).json({
        ok: true,
        replayed,
        lifecycle: lifecycle.status,
        published: lifecycle.publishTelemetry ? Object.keys(lifecycle.telemetryPayload || {}).length : 0,
        durationMs: Date.now() - startedAt,
        correlationId,
      })
    }
    return res.status(400).json({ error: 'Simulation Bridge action must be telemetry, respond, acknowledge, takeover, or release.', code: 'SIMULATION_ACTION_INVALID', correlationId })
  } catch (error) {
    const status = error?.statusCode || (String(error?.code || '').startsWith('SIMULATION_') ? 409 : 502)
    return res.status(status).json({
      error: status === 502 ? 'Simulation Bridge could not reach ThingsBoard.' : error.message,
      code: String(error?.code || 'SIMULATION_BRIDGE_FAILED').slice(0, 80),
      correlationId,
    })
  }
}

async function completeRpcLifecycle(record, runtimeSessionId, transport) {
  if (!record) throw bridgeStateConflict('RPC lifecycle is unavailable.', 'SIMULATION_RPC_UNKNOWN')
  let current = record
  if (current.status === 'received') {
    const claim = await claimSimulationRpcStage(current, 'telemetry', runtimeSessionId)
    if (!claim) throw bridgeStateConflict('RPC telemetry publication is already in progress.', 'SIMULATION_RPC_IN_PROGRESS')
    try {
      if (claim.record.publishTelemetry) {
        const timestamped = timestampedDeviceTelemetry(
          claim.record.telemetryPayload || {},
          claim.record.telemetryTimestamp ?? Date.now()
        )
        await publishDeviceTelemetry({ ...transport, values: timestamped })
      }
      current = await advanceSimulationRpcStage(current._id, 'telemetry', claim.processingOwner)
    } catch (error) {
      await releaseSimulationRpcStage(current._id, 'telemetry', claim.processingOwner)
      throw error
    }
  }
  if (current?.status === 'telemetry_published') {
    const claim = await claimSimulationRpcStage(current, 'response', runtimeSessionId)
    if (!claim) throw bridgeStateConflict('RPC response is already in progress.', 'SIMULATION_RPC_IN_PROGRESS')
    try {
      await respondDeviceRpc({
        ...transport,
        requestId: claim.record.requestId,
        payload: claim.record.responsePayload || {},
      })
      current = await advanceSimulationRpcStage(current._id, 'response', claim.processingOwner)
    } catch (error) {
      await releaseSimulationRpcStage(current._id, 'response', claim.processingOwner)
      throw error
    }
  }
  return current
}

async function loadBridge({ version, project, principal }) {
  const source = (version.schema?.dataSources || []).find(item => item.type === 'thingsboard')
  if (!source) throw bridgeUnavailable('Published Simulation has no ThingsBoard data source.')
  const connector = await Connector.findOne({ _id: source.connectorRef, workspaceId: principal.workspaceId, projectId: project.id, enabled: true }).lean()
  const environmentRef = source.environmentRef || 'staging'
  const environment = connector && await ConnectorEnvironment.findOne({ connectorId: connector._id, environmentRef }).lean()
  if (!connector || !environment?.deviceTokenConfiguredAt) throw bridgeUnavailable('Simulation device token is not configured.')
  const secretRecord = await ConnectorSecret.findById(connectorSecretId(connector._id, environmentRef))
    .select('+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion')
    .lean()
  if (!secretRecord) throw bridgeUnavailable('Simulation device token is not configured.')
  const secret = decryptConnectorSecret(secretRecord, { connectorId: connector._id, environmentRef })
  if (!secret.deviceToken) throw bridgeUnavailable('Simulation device token is not configured.')
  return { connector, environment, deviceToken: secret.deviceToken }
}

async function persistSimulationSnapshots({ schema, telemetryValues, workspaceId, projectId, timestamp }) {
  const sourceTimestamp = new Date(timestamp)
  const receivedAt = new Date()
  const operations = (schema?.tags || []).flatMap(tag => {
    if (!tag?.sourceId || !tag.path || !['read', 'read-write'].includes(tag.access) || telemetryValues[tag.path] == null) return []
    return [{
      updateOne: {
        filter: { _id: `${projectId}:${tag.id}` },
        update: {
          $set: {
            workspaceId,
            projectId,
            sourceId: tag.sourceId,
            tagId: tag.id,
            value: telemetryValues[tag.path],
            dataType: tag.dataType,
            sourceTimestamp,
            receivedAt,
            quality: 'good',
            sequence: timestamp,
          },
        },
        upsert: true,
      },
    }]
  })
  if (operations.length) await TagValueSnapshot.bulkWrite(operations, { ordered: false })
}

function bridgeUnavailable(message) {
  return Object.assign(new Error(message), { code: 'SIMULATION_BRIDGE_UNCONFIGURED', statusCode: 409 })
}
function bridgeStateConflict(message, code) {
  return Object.assign(new Error(message), { code, statusCode: 409 })
}
function digest(value) { return createHash('sha256').update(String(value)).digest('hex') }
