import { AuditEvent, CommandEvent } from '../../api/_lib/models.js'
import { commandTimingProjection } from '../../shared/command-lifecycle.js'
import { commandPurgeAt, commandRetentionPolicy } from '../../shared/command-retention.js'

const COMPLETABLE_STATUSES = ['dispatched', 'accepted_by_gateway']
const TERMINAL_STATUSES = ['acknowledged', 'rejected', 'timeout', 'failed']

export async function persistAndPublishTerminalCommand({
  hub,
  event,
  status,
  message,
  result = {},
  timing = {},
  commandEvents = CommandEvent,
  auditEvents = AuditEvent,
  scheduleAudit = defaultScheduleAudit,
  onAuditError = defaultAuditError,
  onAuditDeferred = () => {},
  onTiming = defaultTimingObserver,
  retentionPolicy = commandRetentionPolicy(),
}) {
  if (!TERMINAL_STATUSES.includes(status)) throw new TypeError(`Unsupported terminal command status: ${status}`)
  const completed = await commandEvents.findOneAndUpdate(
    { _id: event._id, status: { $in: COMPLETABLE_STATUSES } },
    {
      $set: {
        status,
        resultSummary: { ...result, message },
        completedAt: new Date(),
        terminalAuditPending: true,
        ...terminalTimingFields(timing),
      },
    },
    { new: true },
  ).lean()
  if (!completed) return null

  // The terminal record is durable before the browser sees it. Audit persistence
  // runs outside the latency-critical path and is recovered from the pending flag.
  hub.publishCommand(completed)
  onTiming(completed)
  scheduleAudit(
    persistTerminalCommandAudit(completed, { commandEvents, auditEvents, retentionPolicy }),
    error => {
      try {
        onAuditError(error, completed)
      } finally {
        onAuditDeferred(error, completed)
      }
    },
  )
  return completed
}

export async function persistTerminalCommandAudit(event, {
  commandEvents = CommandEvent,
  auditEvents = AuditEvent,
  retentionPolicy = commandRetentionPolicy(),
} = {}) {
  if (!event?._id || !TERMINAL_STATUSES.includes(event.status)) return false
  await auditEvents.updateOne(
    { _id: terminalCommandAuditId(event._id, event.status) },
    {
      $setOnInsert: {
        workspaceId: event.workspaceId,
        projectId: event.projectId,
        actorId: event.actorId,
        action: `command.${event.status}`,
        targetType: 'component',
        targetId: event.componentId,
        correlationId: event.correlationId,
        metadata: { requestId: event.requestId, tagId: event.tagId, result: event.status },
      },
    },
    { upsert: true },
  )
  const retentionFields = { terminalAuditPending: false }
  const purgeAt = commandPurgeAt({ ...event, terminalAuditPending: false }, { policy: retentionPolicy })
  if (purgeAt) retentionFields.purgeAt = purgeAt
  await commandEvents.updateOne(
    { _id: event._id, status: event.status, terminalAuditPending: true },
    { $set: retentionFields },
  )
  return true
}

export async function flushPendingTerminalCommandAudits({
  limit = 100,
  commandEvents = CommandEvent,
  auditEvents = AuditEvent,
  retentionPolicy = commandRetentionPolicy(),
} = {}) {
  const pending = await commandEvents.find({
    terminalAuditPending: true,
    status: { $in: TERMINAL_STATUSES },
  }).sort({ completedAt: 1 }).limit(limit).lean()
  for (const event of pending) {
    await persistTerminalCommandAudit(event, { commandEvents, auditEvents, retentionPolicy })
  }
  return pending.length
}

export function terminalCommandAuditId(commandId, status) {
  return `command-terminal:${commandId}:${status}`
}

function defaultScheduleAudit(promise, onError) {
  void promise.catch(onError)
}

function defaultAuditError(error, event) {
  console.error('[ConnectorWorker] terminal command audit delayed', {
    requestId: event?.requestId,
    code: String(error?.code || error?.name || 'AUDIT_WRITE_FAILED').slice(0, 80),
  })
}

function defaultTimingObserver(event) {
  if (process.env.CONNECTOR_RPC_TIMING_LOGS !== 'true') return
  const timing = commandTimingProjection(event)
  if (!timing) return
  console.log('[ConnectorWorker] RPC timing', {
    requestId: event.requestId,
    correlationId: event.correlationId,
    status: event.status,
    ...timing,
  })
}

function terminalTimingFields(timing) {
  const fields = {}
  if (['two-way', 'feedback-tag'].includes(timing?.acknowledgmentMode)) fields.acknowledgmentMode = timing.acknowledgmentMode
  for (const key of ['upstreamStartedAt', 'gatewayAcceptedAt', 'upstreamCompletedAt']) {
    const value = new Date(timing?.[key] || 0)
    if (Number.isFinite(value.getTime()) && value.getTime() > 0) fields[key] = value
  }
  return fields
}
