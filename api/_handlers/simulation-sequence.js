import { createHash, randomUUID } from 'node:crypto'
import { connectMongo } from '../_lib/mongo.js'
import { AuditEvent, CommandEvent, Project, ProjectVersion, RuntimeSession } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission, roleMeetsRequirement } from '../_lib/authorization.js'
import { enforceRateLimit, requestId as correlationIdFor } from '../_lib/security.js'
import { runtimeProfile } from '../../shared/runtime-profile.js'
import { buildSimulationSequencePlan, resolveSimulationSequenceStep } from '../../shared/simulation-sequence.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  if (!requireCsrf(req, res, principal)) return

  const action = String(req.body?.action || '')
  const projectId = String(req.body?.projectId || '')
  const runtimeToken = String(req.body?.runtimeToken || '')
  const operationComponentId = String(req.body?.operationComponentId || '')
  const operationRequestId = String(req.body?.operationRequestId || '')
  const enabledStepIds = normalizeEnabledStepIds(req.body?.enabledStepIds)
  const correlationId = correlationIdFor(req)
  if (!['start', 'step'].includes(action) || !projectId || !runtimeToken || !operationComponentId || !safeId(operationRequestId) || enabledStepIds === null) {
    return res.status(400).json({ error: 'A valid simulation sequence request is required.', code: 'SIMULATION_SEQUENCE_INPUT_INVALID', correlationId })
  }
  if (!(await enforceRateLimit(req, res, 'simulation-sequence', { limit: 120, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return

  await connectMongo()
  const project = await Project.findById(projectId)
  const authorization = project && await requireProjectPermission(principal, res, project, PERMISSIONS.COMMAND_EXECUTE)
  if (!authorization) return
  const runtimeSession = await RuntimeSession.findOne({
    _id: digest(runtimeToken),
    authSessionId: principal.sessionId,
    userId: principal.id,
    projectId,
    versionId: project.activeVersionId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean()
  if (!runtimeSession?.capabilities?.includes(PERMISSIONS.COMMAND_EXECUTE)) {
    return res.status(403).json({ error: 'Runtime session is invalid or stale.', code: 'RUNTIME_SESSION_INVALID', correlationId })
  }
  const version = await ProjectVersion.findById(project.activeVersionId).lean()
  if (!version) return res.status(409).json({ error: 'Active published version is unavailable.', code: 'VERSION_MISSING', correlationId })
  if (runtimeProfile(version.schema) !== 'simulation') {
    return res.status(409).json({ error: 'The simulation sequence route is isolated from REAL PLC execution.', code: 'SIMULATION_SEQUENCE_PROFILE_REQUIRED', correlationId })
  }

  let plan
  try {
    plan = action === 'step'
      ? resolveSimulationSequenceStep(version.schema, operationComponentId, req.body?.stepId, enabledStepIds)
      : buildSimulationSequencePlan(version.schema, operationComponentId, enabledStepIds)
  } catch (error) {
    return res.status(422).json({ error: error.message, code: error.code || 'SIMULATION_SEQUENCE_INVALID', correlationId })
  }
  if (!roleMeetsRequirement(authorization.effectiveRole, plan.operation.properties?.requiredRole || 'OPERATOR')) {
    return res.status(403).json({ error: 'The assigned role cannot execute this simulation sequence.', code: 'COMMAND_ROLE_DENIED', correlationId })
  }
  const activeOperation = await CommandEvent.findOne({
    projectId,
    versionId: version._id,
    componentId: plan.operation.id,
    actorId: principal.id,
    executionMode: 'mock',
    status: 'acknowledged',
  }).sort({ createdAt: -1 }).lean()
  if (activeOperation?.requestId !== operationRequestId || activeOperation.resultSummary?.value?.mode !== 'auto' || !sameSequence(activeOperation.resultSummary.value.sequence, plan.steps)) {
    return res.status(409).json({ error: 'This simulation sequence is no longer the active AUTO command.', code: 'SIMULATION_SEQUENCE_NOT_ACTIVE', correlationId })
  }

  if (action === 'start') {
    const runId = randomUUID()
    await AuditEvent.create({
      workspaceId: principal.workspaceId,
      projectId,
      actorId: principal.id,
      action: 'simulation.sequence_started',
      targetType: 'component',
      targetId: plan.operation.id,
      correlationId,
      metadata: { runId, operationRequestId, stepIds: plan.steps.map(step => step.id) },
    })
    return res.status(201).json({
      ok: true,
      execution: 'runtime-simulation',
      runId,
      operationComponentId: plan.operation.id,
      steps: plan.steps,
    })
  }

  const runId = String(req.body?.runId || '')
  const requestId = String(req.body?.requestId || '')
  if (!safeId(runId) || !safeId(requestId)) {
    return res.status(400).json({ error: 'runId and requestId are required for a sequence step.', code: 'SIMULATION_SEQUENCE_STEP_INPUT_INVALID', correlationId })
  }
  if (!roleMeetsRequirement(authorization.effectiveRole, plan.component.properties?.requiredRole || 'OPERATOR')) {
    return res.status(403).json({ error: 'The assigned role cannot execute this recipe button.', code: 'COMMAND_ROLE_DENIED', correlationId })
  }
  const duplicate = await CommandEvent.findOne({ projectId, requestId }).lean()
  if (duplicate) {
    if (duplicate.actorId !== principal.id) return res.status(409).json({ error: 'requestId is already in use.', code: 'REQUEST_ID_CONFLICT', correlationId })
    return res.status(200).json(stepResponse(duplicate, plan.changes, true))
  }

  const message = `Simulation AUTO step ${plan.step.order} acknowledged: ${plan.component.properties?.label || plan.component.name || plan.component.id}=${plan.step.value ? 'ACTIVE' : 'INACTIVE'}.`
  const completedAt = new Date()
  const event = await CommandEvent.create({
    requestId,
    workspaceId: principal.workspaceId,
    projectId,
    versionId: version._id,
    componentId: plan.component.id,
    tagId: plan.commandTag.id,
    actorId: principal.id,
    executionMode: 'mock',
    status: 'acknowledged',
    action: 'simulation-sequence-step',
    payloadSummary: { runId, operationRequestId, operationComponentId, stepId: plan.step.id, value: plan.step.value },
    resultSummary: { ok: true, message, value: plan.step.value, changes: plan.changes, runId, stepId: plan.step.id },
    correlationId,
    completedAt,
  })
  await AuditEvent.create({
    workspaceId: principal.workspaceId,
    projectId,
    actorId: principal.id,
    action: 'simulation.sequence_step_acknowledged',
    targetType: 'component',
    targetId: plan.component.id,
    correlationId,
    metadata: { requestId, runId, operationRequestId, operationComponentId, stepId: plan.step.id, value: plan.step.value },
  })
  return res.status(200).json(stepResponse(event.toObject(), plan.changes, false))
}

function normalizeEnabledStepIds(value) {
  if (!Array.isArray(value) || value.length > 64) return null
  return [...new Set(value.map(String).filter(id => id && id.length <= 120))]
}

function stepResponse(event, changes, replayed) {
  return {
    ok: event.status === 'acknowledged',
    replayed,
    requestId: event.requestId,
    status: event.status,
    message: event.resultSummary?.message || event.status,
    componentId: event.componentId,
    tagId: event.tagId,
    value: event.resultSummary?.value,
    changes: event.resultSummary?.changes || changes,
    runId: event.resultSummary?.runId || event.payloadSummary?.runId,
    stepId: event.resultSummary?.stepId || event.payloadSummary?.stepId,
    correlationId: event.correlationId,
    createdAt: event.createdAt || null,
    completedAt: event.completedAt || null,
  }
}

function safeId(value) { return /^[a-zA-Z0-9_-]{8,100}$/.test(value) }
function sameSequence(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false
  return left.every((step, index) => {
    const expected = right[index]
    return String(step?.id) === expected.id
      && String(step?.componentId) === expected.componentId
      && step?.value === expected.value
      && Number(step?.delayMs) === expected.delayMs
  })
}
function digest(value) { return createHash('sha256').update(String(value)).digest('hex') }
