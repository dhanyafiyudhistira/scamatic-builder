import { createHash, randomUUID } from 'node:crypto'
import { SimulationResponderLease, SimulationRpcLifecycle } from './models.js'

const DEFAULT_LEASE_MS = 35_000
const DEFAULT_RPC_RETENTION_MS = 24 * 60 * 60_000
const PROCESSING_LEASE_MS = 15_000

export function simulationResponderPolicy() {
  return {
    leaseMs: boundedInteger(process.env.SIMULATION_RESPONDER_LEASE_MS, 25_000, 60_000, DEFAULT_LEASE_MS),
    rpcRetentionMs: boundedInteger(process.env.SIMULATION_RPC_RETENTION_MS, 60 * 60_000, 7 * 24 * 60 * 60_000, DEFAULT_RPC_RETENTION_MS),
  }
}

export async function acquireSimulationResponderLease({ responderKey, projectId, versionId, runtimeSessionId, responderId, responderGeneration = 1, now = new Date() }) {
  const policy = simulationResponderPolicy()
  const expiresAt = new Date(now.getTime() + policy.leaseMs)
  const normalizedResponderKey = validResponderKey(responderKey)
  const normalizedResponderId = validLeaseResponderId(responderId, runtimeSessionId)
  const normalizedGeneration = validLeaseGeneration(responderGeneration)
  const _id = responderLeaseId(normalizedResponderKey)
  try {
    const lease = await SimulationResponderLease.findOneAndUpdate(
      {
        _id,
        $or: [
          { runtimeSessionId },
          { expiresAt: { $lte: now } },
          {
            $and: [
              { responderId: normalizedResponderId },
              {
                $or: [
                  { responderGeneration: { $lt: normalizedGeneration } },
                  { responderGeneration: { $exists: false } },
                ],
              },
            ],
          },
          {
            responderId: { $exists: false },
            projectId,
            versionId,
          },
        ],
      },
      {
        $set: { responderKey: normalizedResponderKey, projectId, versionId, runtimeSessionId, responderId: normalizedResponderId, responderGeneration: normalizedGeneration, expiresAt },
        $setOnInsert: { _id },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean()
    return { active: Boolean(lease), expiresAt: lease?.expiresAt || expiresAt, retryAfterMs: 0 }
  } catch (error) {
    if (Number(error?.code) !== 11000) throw error
    const current = await SimulationResponderLease.findById(_id).lean()
    const retryAfterMs = Math.max(1000, new Date(current?.expiresAt || expiresAt).getTime() - now.getTime())
    return { active: false, expiresAt: current?.expiresAt || expiresAt, retryAfterMs }
  }
}

export async function takeoverSimulationResponderLease({ responderKey, projectId, versionId, runtimeSessionId, responderId, responderGeneration = 1, now = new Date() }) {
  const policy = simulationResponderPolicy()
  const normalizedResponderKey = validResponderKey(responderKey)
  const normalizedResponderId = validLeaseResponderId(responderId, runtimeSessionId)
  const normalizedGeneration = validLeaseGeneration(responderGeneration)
  const expiresAt = new Date(now.getTime() + policy.leaseMs)
  const lease = await SimulationResponderLease.findOneAndUpdate(
    { _id: responderLeaseId(normalizedResponderKey) },
    {
      $set: {
        responderKey: normalizedResponderKey,
        projectId,
        versionId,
        runtimeSessionId,
        responderId: normalizedResponderId,
        responderGeneration: normalizedGeneration,
        expiresAt,
      },
      $setOnInsert: { _id: responderLeaseId(normalizedResponderKey) },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean()
  return { active: true, takenOver: true, expiresAt: lease?.expiresAt || expiresAt, retryAfterMs: 0 }
}

export async function releaseSimulationResponderLease({ responderKey, runtimeSessionId }) {
  const normalizedResponderKey = validResponderKey(responderKey)
  const result = await SimulationResponderLease.deleteOne({
    _id: responderLeaseId(normalizedResponderKey),
    runtimeSessionId: String(runtimeSessionId || ''),
  })
  return { released: Number(result?.deletedCount || 0) > 0 }
}

export async function recordSimulationRpc({ projectId, versionId, runtimeSessionId, request, now = new Date() }) {
  const requestId = validRequestId(request?.id)
  const _id = simulationRpcLifecycleId(projectId, versionId, requestId)
  const expiresAt = new Date(now.getTime() + simulationResponderPolicy().rpcRetentionMs)
  const record = await SimulationRpcLifecycle.findOneAndUpdate(
    { _id },
    {
      $setOnInsert: {
        _id,
        projectId,
        versionId,
        requestId,
        request: { id: request.id, method: request.method, params: request.params },
        status: 'received',
        receivedAt: now,
        expiresAt,
      },
      $set: { responderRuntimeSessionId: runtimeSessionId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean()
  return record
}

export async function findPendingSimulationRpc({ projectId, versionId, runtimeSessionId }) {
  const record = await SimulationRpcLifecycle.findOne({
    projectId,
    versionId,
    status: { $in: ['received', 'telemetry_published'] },
  }).sort({ receivedAt: 1 }).lean()
  if (!record) return null
  if (record.responderRuntimeSessionId === runtimeSessionId) return record
  return SimulationRpcLifecycle.findOneAndUpdate(
    { _id: record._id, status: record.status },
    { $set: { responderRuntimeSessionId: runtimeSessionId } },
    { new: true }
  ).lean()
}

export async function storeSimulationRpcCompletion({
  projectId,
  versionId,
  runtimeSessionId,
  requestId,
  responsePayload,
  telemetryPayload,
  telemetryTimestamp,
  publishTelemetry,
}) {
  const _id = simulationRpcLifecycleId(projectId, versionId, validRequestId(requestId))
  const existing = await SimulationRpcLifecycle.findOne({ _id, projectId, versionId }).lean()
  if (!existing) throw rpcStateError('RPC lifecycle was not found.', 'SIMULATION_RPC_UNKNOWN', 409)
  if (existing.status === 'responded' || existing.responsePayload !== undefined) {
    if (existing.responderRuntimeSessionId === runtimeSessionId) return existing
    return SimulationRpcLifecycle.findByIdAndUpdate(_id, { $set: { responderRuntimeSessionId: runtimeSessionId } }, { new: true }).lean()
  }
  return SimulationRpcLifecycle.findOneAndUpdate(
    { _id, status: 'received', responsePayload: { $exists: false } },
    {
      $set: {
        responderRuntimeSessionId: runtimeSessionId,
        responsePayload: responsePayload || {},
        telemetryPayload: telemetryPayload || {},
        telemetryTimestamp: Number(telemetryTimestamp) || Date.now(),
        publishTelemetry: Boolean(publishTelemetry),
      },
    },
    { new: true }
  ).lean()
}

export async function claimSimulationRpcStage(record, stage, runtimeSessionId, now = new Date()) {
  const expectedStatus = stage === 'telemetry' ? 'received' : 'telemetry_published'
  const processingOwner = randomUUID()
  const claimed = await SimulationRpcLifecycle.findOneAndUpdate(
    {
      _id: record._id,
      status: expectedStatus,
      responderRuntimeSessionId: runtimeSessionId,
      $or: [
        { processingStage: null },
        { processingExpiresAt: null },
        { processingExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        processingStage: stage,
        processingOwner,
        processingExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_MS),
      },
    },
    { new: true }
  ).lean()
  return claimed ? { record: claimed, processingOwner } : null
}

export async function advanceSimulationRpcStage(recordId, stage, processingOwner, now = new Date()) {
  const update = stage === 'telemetry'
    ? { status: 'telemetry_published', telemetryPublishedAt: now }
    : { status: 'responded', respondedAt: now }
  return SimulationRpcLifecycle.findOneAndUpdate(
    { _id: recordId, processingStage: stage, processingOwner },
    {
      $set: { ...update, processingStage: null, processingOwner: null, processingExpiresAt: null },
    },
    { new: true }
  ).lean()
}

export async function releaseSimulationRpcStage(recordId, stage, processingOwner) {
  await SimulationRpcLifecycle.updateOne(
    { _id: recordId, processingStage: stage, processingOwner },
    { $set: { processingStage: null, processingOwner: null, processingExpiresAt: null } }
  )
}

export function simulationRpcLifecycleId(projectId, versionId, requestId) {
  return createHash('sha256').update(`${projectId}:${versionId}:${requestId}`).digest('hex')
}

export function simulationResponderKey(serverUrl, deviceToken) {
  let target = String(serverUrl || '').trim()
  try { target = new URL(target).origin.toLowerCase() } catch { /* Transport validation returns the public error. */ }
  return createHash('sha256').update(`${target}\0${String(deviceToken).trim()}`).digest('hex')
}

function responderLeaseId(responderKey) {
  return createHash('sha256').update(`simulation-responder:${responderKey}`).digest('hex')
}

function validResponderKey(value) {
  const key = String(value || '')
  if (!/^[a-f0-9]{64}$/.test(key)) throw rpcStateError('Simulation responder key is invalid.', 'SIMULATION_RESPONDER_KEY_INVALID', 500)
  return key
}

function validLeaseResponderId(value, runtimeSessionId) {
  const id = String(value || runtimeSessionId || '')
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id)) throw rpcStateError('Simulation responder identity is invalid.', 'SIMULATION_RESPONDER_ID_INVALID', 500)
  return id
}

function validLeaseGeneration(value) {
  const generation = Number(value)
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2_147_483_647) {
    throw rpcStateError('Simulation responder generation is invalid.', 'SIMULATION_RESPONDER_GENERATION_INVALID', 500)
  }
  return generation
}

function validRequestId(value) {
  const id = String(value ?? '')
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw rpcStateError('RPC request ID is invalid.', 'SIMULATION_RPC_ID_INVALID', 400)
  return id
}

function rpcStateError(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode })
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback
}
