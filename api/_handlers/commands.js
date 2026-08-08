import { createHash } from 'node:crypto'
import { connectMongo } from '../_lib/mongo.js'
import { AuditEvent, CommandEvent, Connector, ConnectorEnvironment, Project, ProjectVersion, RuntimeSession, TagValueSnapshot } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission, roleMeetsRequirement } from '../_lib/authorization.js'
import { enforceRateLimit, requestId as correlationIdFor } from '../_lib/security.js'
import { executeMockCommand, initialMockValue } from '../../shared/runtime-evaluator.js'
import { isTerminalCommandStatus } from '../../shared/command-lifecycle.js'
import { commandAcknowledgment, commandAcknowledgmentTimeout } from '../../shared/command-acknowledgment.js'
import { usesServerlessConnectorExecution } from '../_lib/connector-execution.js'
import { sendThingsBoardRpc, waitForThingsBoardFeedback } from '../_lib/thingsboard-serverless.js'
import { withThingsBoardAccessToken } from '../_lib/thingsboard-auth.js'
import { runtimeCommandExecutionPlan, runtimeProfile } from '../../shared/runtime-profile.js'
import { previousSimulationCommandValue } from '../../shared/simulation-command-state.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  if (req.method === 'GET') return commandStatus(req, res, principal)
  if (!requireCsrf(req, res, principal)) return
  const { projectId, runtimeToken, requestId, componentId, confirmed = false, value } = req.body || {}
  if (!projectId || !componentId || !/^[a-zA-Z0-9_-]{8,100}$/.test(String(requestId || '')) || !runtimeToken) return res.status(400).json({ error: 'projectId, componentId, runtimeToken, and requestId are required.' })
  if (!(await enforceRateLimit(req, res, 'runtime-command', { limit: 30, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return
  const correlationId = correlationIdFor(req)

  await connectMongo()
  const project = await Project.findById(projectId)
  const authorization = project && await requireProjectPermission(principal, res, project, PERMISSIONS.COMMAND_EXECUTE)
  if (!authorization) return
  const runtimeSession = await RuntimeSession.findOne({ _id: digest(runtimeToken), authSessionId: principal.sessionId, userId: principal.id, projectId, revokedAt: null, expiresAt: { $gt: new Date() } }).lean()
  if (!runtimeSession || runtimeSession.versionId !== project.activeVersionId || !runtimeSession.capabilities.includes(PERMISSIONS.COMMAND_EXECUTE)) return reject(res, principal, project, { requestId, componentId, correlationId, reason: 'Runtime session is invalid or stale.', code: 'RUNTIME_SESSION_INVALID' })
  const duplicate = await CommandEvent.findOne({ projectId, requestId }).lean()
  if (duplicate) {
    if (duplicate.actorId !== principal.id) return res.status(409).json({ error: 'requestId is already in use.', code: 'REQUEST_ID_CONFLICT', correlationId })
    return res.status(200).json(commandResponse(duplicate, true))
  }
  const version = await ProjectVersion.findById(project.activeVersionId).lean()
  const component = version?.schema?.components?.find(item => item.id === componentId)
  const tag = component && version.schema.tags?.find(item => item.id === component.binding?.tagId)
  const source = tag && version.schema.dataSources?.find(item => item.id === tag.sourceId)
  if (!component || !['control-button', 'tuning-slider', 'operation-shifter'].includes(component.type) || !tag || !source) return reject(res, principal, project, { requestId, componentId, correlationId, reason: 'Command component is not present in the active version.', code: 'COMMAND_NOT_ALLOWED' })
  const profile = runtimeProfile(version.schema)
  if (profile === 'monitor') return reject(res, principal, project, { requestId, componentId, tagId: tag.id, correlationId, reason: 'Commands are blocked by the MONITOR ONLY runtime profile.', code: 'RUNTIME_MONITOR_ONLY' })
  if (profile === 'real' && source.type === 'mock') return reject(res, principal, project, { requestId, componentId, tagId: tag.id, correlationId, reason: 'REAL PLC commands require a live connector-backed tag.', code: 'REAL_COMMAND_SOURCE_REQUIRED' })
  if (!roleMeetsRequirement(authorization.effectiveRole, component.properties?.requiredRole || 'OPERATOR')) return reject(res, principal, project, { requestId, componentId, tagId: tag.id, correlationId, reason: 'The assigned role cannot execute this command.', code: 'COMMAND_ROLE_DENIED' })
  if (!['write', 'read-write'].includes(tag.access)) return reject(res, principal, project, { requestId, componentId, tagId: tag.id, correlationId, reason: 'Command tag is read-only.', code: 'TAG_READ_ONLY' })
  if (component.properties?.confirmation === 'single' && !confirmed) return reject(res, principal, project, { requestId, componentId, tagId: tag.id, correlationId, reason: 'Command confirmation is required.', code: 'CONFIRMATION_REQUIRED' })
  const recent = await CommandEvent.findOne({ projectId, componentId, actorId: principal.id, status: { $in: ['requested', 'authorized', 'dispatched', 'accepted_by_gateway'] }, createdAt: { $gt: new Date(Date.now() - 1_500) } }).lean()
  if (recent) return res.status(409).json({ error: 'Command is already pending.', code: 'COMMAND_COOLDOWN', correlationId })

  const snapshot = profile === 'simulation' ? null : await TagValueSnapshot.findOne({ projectId, tagId: tag.id }).lean()
  const simulationCommands = profile === 'simulation'
    ? await CommandEvent.find({ projectId, versionId: version._id, status: 'acknowledged', executionMode: 'mock' }).sort({ createdAt: -1 }).limit(200).lean()
    : null
  const previous = profile === 'simulation'
    ? previousSimulationCommandValue(version.schema, simulationCommands, component, tag)
    : snapshot?.value ?? (await CommandEvent.findOne({ projectId, tagId: tag.id, status: 'acknowledged', executionMode: { $ne: 'mock' } }).sort({ createdAt: -1 }).lean())?.resultSummary?.value ?? initialMockValue(tag)
  const evaluated = executeMockCommand(component, tag, previous, value, { components: version.schema.components })
  if (!evaluated.ok) return reject(res, principal, project, { requestId, componentId, tagId: tag.id, correlationId, reason: evaluated.message, code: 'COMMAND_PAYLOAD_INVALID' })
  const action = component.type === 'tuning-slider' ? 'set-value' : component.type === 'operation-shifter' ? 'operation-shift' : (component.properties?.action || 'toggle-boolean')
  const executionPlan = runtimeCommandExecutionPlan(version.schema, {
    sourceType: source.type,
    serverlessAvailable: usesServerlessConnectorExecution(),
  })
  const serverlessExecution = executionPlan.executionMode === 'serverless'
  const event = await CommandEvent.create({ requestId, workspaceId: principal.workspaceId, projectId, versionId: version._id, componentId, tagId: tag.id, actorId: principal.id, executionMode: executionPlan.executionMode, status: executionPlan.initialStatus, action, payloadSummary: { action, value: evaluated.value }, correlationId })
  if (!serverlessExecution) {
    event.status = 'authorized'
    await event.save()
  }
  await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'command.authorized', targetType: 'component', targetId: componentId, correlationId, metadata: { requestId, tagId: tag.id, sourceId: source.id } })

  if (profile === 'simulation') return executeMock(event, evaluated, principal, res)
  if (process.env.CONNECTOR_PLATFORM_ENABLED !== 'true' || process.env.CONNECTOR_LIVE_COMMANDS_ENABLED !== 'true') return finishUnavailable(event, res, 'Live connector commands are disabled.', 'LIVE_COMMANDS_DISABLED')
  const connector = await Connector.findOne({ _id: source.connectorRef, workspaceId: principal.workspaceId, projectId, enabled: true }).lean()
  const environment = connector && await ConnectorEnvironment.findOne({ connectorId: connector._id, environmentRef: source.environmentRef || 'staging' }).lean()
  if (!connector || !environment) return finishUnavailable(event, res, 'Connector configuration is unavailable.', 'CONNECTOR_UNAVAILABLE')
  if (environment.config?.rpcMode !== 'two-way' && !component.properties?.feedbackTagId) return finishUnavailable(event, res, 'A feedback tag or two-way RPC acknowledgment is required.', 'ACKNOWLEDGMENT_REQUIRED')
  if (serverlessExecution) {
    return executeServerlessCommand({ event, evaluated, principal, res, version, component, connector, environment })
  }
  if (environment.health?.state !== 'online') return finishUnavailable(event, res, 'Connector is not online.', 'CONNECTOR_OFFLINE')

  const timeoutMs = Math.max(1000, Math.min(30000, Number(component.properties?.ackTimeoutMs || environment.config?.commandTimeoutMs || 5000)))
  const completed = await waitForCommand(event.id, timeoutMs + 1500)
  if (!completed || !isTerminalCommandStatus(completed.status)) return res.status(202).json(commandResponse(completed || event.toObject(), false))
  return res.status(completed.status === 'acknowledged' ? 200 : completed.status === 'timeout' ? 504 : 502).json(commandResponse(completed, false))
}

async function commandStatus(req, res, principal) {
  const projectId = String(req.query?.projectId || '')
  const requestId = String(req.query?.requestId || '')
  const recent = req.query?.recent === '1'
  const runtimeToken = String(req.headers?.['x-runtime-token'] || '')
  const correlationId = correlationIdFor(req)
  if (!projectId || !runtimeToken || (!recent && !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))) {
    return res.status(400).json({ error: 'projectId, X-Runtime-Token, and either requestId or recent=1 are required.', code: 'COMMAND_STATUS_INPUT_INVALID', correlationId })
  }
  await connectMongo()
  if (!(await enforceRateLimit(req, res, 'runtime-command-status', { limit: 180, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return
  const project = await Project.findById(projectId)
  const authorization = project && await requireProjectPermission(principal, res, project, PERMISSIONS.COMMAND_EXECUTE)
  if (!authorization) return
  const runtimeSession = await RuntimeSession.findOne({ _id: digest(runtimeToken), authSessionId: principal.sessionId, userId: principal.id, projectId, revokedAt: null, expiresAt: { $gt: new Date() } }).lean()
  if (!runtimeSession || runtimeSession.versionId !== project.activeVersionId || !runtimeSession.capabilities.includes(PERMISSIONS.COMMAND_EXECUTE)) {
    return res.status(403).json({ error: 'Runtime session is invalid or stale.', code: 'RUNTIME_SESSION_INVALID', correlationId })
  }
  if (recent) {
    const events = await CommandEvent.find({ projectId, versionId: project.activeVersionId, actorId: principal.id }).sort({ createdAt: -1 }).limit(20).lean()
    return res.status(200).json({ commands: events.map(event => commandResponse(event, false)) })
  }
  const event = await CommandEvent.findOne({ projectId, requestId, actorId: principal.id }).lean()
  if (!event) return res.status(404).json({ error: 'Command request was not found.', code: 'COMMAND_NOT_FOUND', correlationId })
  return res.status(200).json(commandResponse(event, false))
}

async function executeMock(event, result, principal, res) {
  event.status = 'dispatched'; await event.save()
  event.status = result.ok ? 'acknowledged' : 'failed'
  event.resultSummary = { ok: result.ok, message: result.message, value: result.value, resetAfterMs: result.resetAfterMs || null }
  event.completedAt = new Date(); await event.save()
  await AuditEvent.create({ workspaceId: principal.workspaceId, projectId: event.projectId, actorId: principal.id, action: result.ok ? 'command.acknowledged' : 'command.failed', targetType: 'component', targetId: event.componentId, correlationId: event.correlationId, metadata: { requestId: event.requestId, tagId: event.tagId, action: event.action, result: event.status } })
  return res.status(result.ok ? 200 : 502).json(commandResponse(event.toObject(), false))
}

async function executeServerlessCommand({ event, evaluated, principal, res, version, component, connector, environment }) {
  const acknowledgment = commandAcknowledgment(component, environment.config, evaluated.value)
  if (!acknowledgment) return finishUnavailable(event, res, 'Command acknowledgment is not configured.', 'ACKNOWLEDGMENT_REQUIRED')
  if (!environment.secretConfiguredAt) return finishUnavailable(event, res, 'Connector secret is not configured.', 'CONNECTOR_SECRET_MISSING')
  const feedbackTag = acknowledgment.mode === 'feedback-tag'
    ? version.schema.tags?.find(item => item.id === acknowledgment.tagId)
    : null
  if (acknowledgment.mode === 'feedback-tag' && (!feedbackTag || !['read', 'read-write'].includes(feedbackTag.access))) {
    return finishUnavailable(event, res, 'Configured command feedback tag is unavailable.', 'FEEDBACK_TAG_INVALID')
  }

  if (event.status !== 'dispatched') {
    event.status = 'dispatched'
    await event.save()
  }
  const dispatchedAt = Date.now()
  await AuditEvent.create({
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    actorId: event.actorId,
    action: 'command.dispatched',
    targetType: 'component',
    targetId: event.componentId,
    correlationId: event.correlationId,
    metadata: { requestId: event.requestId, tagId: event.tagId, executionMode: 'serverless' },
  })
  await updateServerlessCommandHealth(environment, 'waiting', acknowledgment.mode === 'two-way'
    ? 'Waiting for device RPC response.'
    : 'Waiting for process feedback.')

  try {
    const primary = await performServerlessRpc({
      connector,
      environment,
      component,
      acknowledgment,
      feedbackTag,
      targetValue: evaluated.value,
      feedbackAfterTimestamp: dispatchedAt,
    })
    if (primary.accepted) await markAcceptedByGateway(event, primary.code)
    const primaryFailure = await serverlessFailure(primary, { event, environment, res, acknowledgment })
    if (primaryFailure) return primaryFailure

    if (evaluated.resetAfterMs) {
      await delay(evaluated.resetAfterMs)
      const release = await performServerlessRpc({
        connector,
        environment,
        component,
        acknowledgment,
        feedbackTag,
        targetValue: false,
        expectedFeedbackValue: false,
        feedbackAfterTimestamp: Date.now(),
      })
      const releaseFailure = await serverlessFailure(release, { event, environment, res, acknowledgment, pulseRelease: true })
      if (releaseFailure) return releaseFailure
    }

    await updateServerlessCommandHealth(
      environment,
      'online',
      acknowledgment.mode === 'two-way' ? 'Device RPC responder acknowledged the command.' : 'Process feedback matched the command.',
      { lastAcknowledgedAt: new Date() },
    )
    return finishLiveCommand(event, res, 'acknowledged', 'Command acknowledged.', {
      value: evaluated.value,
      receipt: primary.code,
      resetAfterMs: evaluated.resetAfterMs || null,
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      const timeout = commandAcknowledgmentTimeout(acknowledgment.mode)
      await updateServerlessCommandHealth(environment, timeout.commandHealth.state, timeout.commandHealth.message, { lastTimeoutAt: new Date() })
      return finishLiveCommand(event, res, timeout.command.status, timeout.command.message, timeout.command.result)
    }
    await updateServerlessCommandHealth(environment, 'degraded', 'ThingsBoard RPC dispatch failed.')
    return finishLiveCommand(event, res, 'failed', 'Command dispatch failed.', {
      code: String(error?.code || error?.name || 'RPC_DISPATCH_FAILED').slice(0, 80),
    })
  }
}

async function performServerlessRpc({ connector, environment, component, acknowledgment, feedbackTag, targetValue, expectedFeedbackValue, feedbackAfterTimestamp }) {
  const authContext = { connectorId: connector._id, environmentRef: environment.environmentRef }
  const receipt = await withThingsBoardAccessToken(
    authContext,
    jwt => sendThingsBoardRpc({
      config: environment.config,
      jwt,
      method: component.properties?.rpcMethod || component.properties?.action || 'setValue',
      params: targetValue,
      timeoutMs: acknowledgment.timeoutMs,
      mode: acknowledgment.mode,
    }),
  )
  if (!receipt.accepted || receipt.rejected || receipt.timedOut || receipt.acknowledged || acknowledgment.mode !== 'feedback-tag') return receipt
  const feedback = await withThingsBoardAccessToken(
    authContext,
    jwt => waitForThingsBoardFeedback({
      config: environment.config,
      jwt,
      key: feedbackTag.path,
      dataType: feedbackTag.dataType,
      expectedValue: expectedFeedbackValue ?? acknowledgment.expectedValue,
      timeoutMs: acknowledgment.timeoutMs,
      afterTimestamp: feedbackAfterTimestamp,
    }),
  )
  return {
    ...receipt,
    acknowledged: feedback.matched,
    code: feedback.matched ? 'FEEDBACK_ACK' : 'FEEDBACK_TIMEOUT',
    feedback: feedback.sample,
  }
}

async function serverlessFailure(receipt, { event, environment, res, acknowledgment, pulseRelease = false }) {
  if (receipt.rejected) {
    await updateServerlessCommandHealth(environment, 'online', 'Device RPC responder returned a rejection.')
    return finishLiveCommand(event, res, 'rejected', pulseRelease ? 'Device rejected the pulse release.' : 'Device rejected the command.', { code: receipt.code })
  }
  if (!receipt.accepted) {
    await updateServerlessCommandHealth(environment, 'degraded', 'ThingsBoard rejected the RPC dispatch.')
    return finishLiveCommand(event, res, 'failed', pulseRelease ? 'ThingsBoard rejected the pulse release.' : 'ThingsBoard rejected the RPC.', { code: receipt.code })
  }
  if (receipt.timedOut || !receipt.acknowledged) {
    const timeout = commandAcknowledgmentTimeout(acknowledgment.mode, receipt.code)
    await updateServerlessCommandHealth(environment, timeout.commandHealth.state, timeout.commandHealth.message, { lastTimeoutAt: new Date() })
    return finishLiveCommand(
      event,
      res,
      timeout.command.status,
      pulseRelease ? 'Pulse release acknowledgment timed out; outcome is unverified.' : timeout.command.message,
      timeout.command.result,
    )
  }
  return null
}

async function markAcceptedByGateway(event, receipt) {
  if (event.status === 'accepted_by_gateway') return
  event.status = 'accepted_by_gateway'
  event.resultSummary = { message: 'Accepted by ThingsBoard gateway.', receipt }
  await event.save()
  await AuditEvent.create({
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    actorId: event.actorId,
    action: 'command.accepted_by_gateway',
    targetType: 'component',
    targetId: event.componentId,
    correlationId: event.correlationId,
    metadata: { requestId: event.requestId, tagId: event.tagId, receipt },
  })
}

async function finishLiveCommand(event, res, status, message, result = {}) {
  event.status = status
  event.resultSummary = { ...result, message }
  event.completedAt = new Date()
  await event.save()
  await AuditEvent.create({
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    actorId: event.actorId,
    action: `command.${status}`,
    targetType: 'component',
    targetId: event.componentId,
    correlationId: event.correlationId,
    metadata: { requestId: event.requestId, tagId: event.tagId, result: status, executionMode: 'serverless' },
  })
  const httpStatus = status === 'acknowledged' ? 200 : status === 'timeout' ? 504 : status === 'rejected' ? 422 : 502
  return res.status(httpStatus).json(commandResponse(event.toObject(), false))
}

async function updateServerlessCommandHealth(environment, state, message, timestamps = {}) {
  const checkedAt = new Date()
  const fields = {
    'commandHealth.state': state,
    'commandHealth.message': message,
    'commandHealth.checkedAt': checkedAt,
  }
  if (timestamps.lastAcknowledgedAt) fields['commandHealth.lastAcknowledgedAt'] = timestamps.lastAcknowledgedAt
  if (timestamps.lastTimeoutAt) fields['commandHealth.lastTimeoutAt'] = timestamps.lastTimeoutAt
  await ConnectorEnvironment.updateOne({ _id: environment._id }, { $set: fields })
}

async function finishUnavailable(event, res, message, code) {
  event.status = 'rejected'; event.completedAt = new Date(); event.resultSummary = { ok: false, message, code }; await event.save()
  await AuditEvent.create({ workspaceId: event.workspaceId, projectId: event.projectId, actorId: event.actorId, action: 'command.rejected', targetType: 'component', targetId: event.componentId, correlationId: event.correlationId, metadata: { requestId: event.requestId, tagId: event.tagId, reason: code } })
  return res.status(409).json(commandResponse(event.toObject(), false))
}

async function waitForCommand(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await CommandEvent.findById(id).lean()
    if (!current || isTerminalCommandStatus(current.status)) return current
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return CommandEvent.findById(id).lean()
}

async function reject(res, principal, project, details) {
  await AuditEvent.create({ workspaceId: principal.workspaceId, projectId: project?.id || null, actorId: principal.id, action: 'command.rejected', targetType: 'component', targetId: details.componentId || null, correlationId: details.correlationId, metadata: { requestId: details.requestId, tagId: details.tagId || null, reason: details.code } })
  return res.status(403).json({ error: details.reason, code: details.code, correlationId: details.correlationId })
}
function commandResponse(event, replayed) { return { ok: event.status === 'acknowledged', replayed, requestId: event.requestId, status: event.status, message: event.resultSummary?.message || event.status, code: event.resultSummary?.code || null, componentId: event.componentId, tagId: event.tagId, value: event.resultSummary?.value, resetAfterMs: event.resultSummary?.resetAfterMs || null, correlationId: event.correlationId, createdAt: event.createdAt || null, completedAt: event.completedAt || null } }
function digest(value) { return createHash('sha256').update(String(value)).digest('hex') }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
