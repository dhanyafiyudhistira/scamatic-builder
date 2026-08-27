import { randomUUID } from 'node:crypto'
import { AuditEvent, CommandEvent, CommandRetentionLease, TagValueSnapshot } from '../../api/_lib/models.js'
import { connectMongo } from '../../api/_lib/mongo.js'
import {
  commandPurgeAt,
  commandRetentionCutoff,
  commandRetentionPolicy,
  RETENTION_ELIGIBLE_STATUSES,
  RETENTION_LIVE_EXECUTION_MODES,
} from '../../shared/command-retention.js'

export const COMMAND_RETENTION_INDEX = 'command_purge_at_1'
const LEASE_ID = 'rpc-command-retention'

export class CommandRetentionJanitor {
  constructor({
    commandEvents = CommandEvent,
    auditEvents = AuditEvent,
    tagValueSnapshots = TagValueSnapshot,
    leases = CommandRetentionLease,
    connect = connectMongo,
    environment = process.env,
    ownerId = randomUUID(),
    now = () => new Date(),
    logger = console,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    this.commandEvents = commandEvents
    this.auditEvents = auditEvents
    this.tagValueSnapshots = tagValueSnapshots
    this.leases = leases
    this.connect = connect
    this.policy = commandRetentionPolicy(environment)
    this.ownerId = ownerId
    this.now = now
    this.logger = logger
    this.setTimeoutImpl = setTimeoutImpl
    this.clearTimeoutImpl = clearTimeoutImpl
    this.timer = null
    this.running = null
    this.stopping = false
    this.indexReady = false
    this.indexWarningReported = false
    this.leaseOwned = false
  }

  start() {
    if (!this.policy.enabled || this.stopping || this.timer || this.running) return false
    this.logger.log('[RetentionJanitor] RPC command retention enabled in bounded-batch mode.')
    this.#schedule(this.policy.initialDelayMs)
    return true
  }

  async runOnce() {
    if (!this.policy.enabled || this.stopping) return { skipped: 'disabled' }
    if (this.running) return this.running
    this.running = this.#cycle()
    try {
      return await this.running
    } finally {
      this.running = null
    }
  }

  async close() {
    this.stopping = true
    if (this.timer) this.clearTimeoutImpl(this.timer)
    this.timer = null
    if (this.running) await this.running.catch(() => {})
    if (this.leaseOwned) {
      await releaseRetentionLease({ leases: this.leases, ownerId: this.ownerId, now: this.now() }).catch(() => {})
      this.leaseOwned = false
    }
  }

  async #cycle() {
    await this.connect()
    this.indexReady = await retentionIndexExists(this.commandEvents)
    if (!this.indexReady) {
      if (!this.indexWarningReported) {
        this.indexWarningReported = true
        this.logger.error(`[RetentionJanitor] ${COMMAND_RETENTION_INDEX} is missing; cleanup remains disabled. Run the explicit retention index migration.`)
      }
      return { skipped: 'index-missing' }
    }
    this.indexWarningReported = false
    const acquired = await acquireRetentionLease({
      leases: this.leases,
      ownerId: this.ownerId,
      now: this.now(),
      leaseMs: this.policy.leaseMs,
    })
    if (!acquired) return { skipped: 'lease-held' }
    this.leaseOwned = true

    const purged = await purgeExpiredCommands({
      commandEvents: this.commandEvents,
      tagValueSnapshots: this.tagValueSnapshots,
      policy: this.policy,
      now: this.now(),
    })
    const marked = await markExpiredCommandsForPurge({
      commandEvents: this.commandEvents,
      auditEvents: this.auditEvents,
      policy: this.policy,
      now: this.now(),
    })
    if (purged.deletedCount || marked.markedCount) {
      this.logger.log('[RetentionJanitor] RPC command retention cycle complete.', {
        deleted: purged.deletedCount,
        marked: marked.markedCount,
        stateProtected: purged.stateProtected,
      })
    }
    return { ...purged, ...marked }
  }

  #schedule(delayMs) {
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null
      void this.runOnce()
        .catch(error => this.logger.error('[RetentionJanitor] RPC command retention cycle failed.', {
          code: String(error?.code || error?.name || 'RETENTION_FAILED').slice(0, 80),
        }))
        .finally(() => {
          if (!this.stopping) this.#schedule(this.policy.intervalMs)
        })
    }, delayMs)
    this.timer.unref?.()
  }
}

export async function purgeExpiredCommands({
  commandEvents = CommandEvent,
  tagValueSnapshots = TagValueSnapshot,
  policy = commandRetentionPolicy(),
  now = new Date(),
} = {}) {
  if (!policy.enabled) return { selectedCount: 0, deletedCount: 0, stateProtected: 0 }
  const candidates = await commandEvents.find({
    purgeAt: { $lte: now },
    terminalAuditPending: false,
    status: { $in: RETENTION_ELIGIBLE_STATUSES },
    executionMode: { $in: RETENTION_LIVE_EXECUTION_MODES },
  }).sort({ purgeAt: 1 }).limit(policy.batchSize).maxTimeMS(policy.queryMaxTimeMs).lean()
  if (!candidates.length) return { selectedCount: 0, deletedCount: 0, stateProtected: 0 }

  const acknowledged = candidates.filter(event => event.status === 'acknowledged')
  const snapshotKeys = await loadSnapshotKeys(acknowledged, tagValueSnapshots, policy.queryMaxTimeMs)
  const deletable = candidates.filter(event => event.status !== 'acknowledged' || snapshotKeys.has(snapshotKey(event)))
  const protectedEvents = candidates.filter(event => event.status === 'acknowledged' && !snapshotKeys.has(snapshotKey(event)))
  if (protectedEvents.length) {
    await commandEvents.bulkWrite(protectedEvents.map(event => ({
      updateOne: {
        filter: {
          _id: event._id,
          status: 'acknowledged',
          terminalAuditPending: false,
          purgeAt: { $lte: now },
        },
        update: { $set: { purgeAt: new Date(now.getTime() + policy.stateRecheckMs) } },
      },
    })), { ordered: false, maxTimeMS: policy.queryMaxTimeMs })
  }
  if (!deletable.length) {
    return { selectedCount: candidates.length, deletedCount: 0, stateProtected: acknowledged.length }
  }
  const result = await commandEvents.deleteMany({
    _id: { $in: deletable.map(event => event._id) },
    purgeAt: { $lte: now },
    terminalAuditPending: false,
    status: { $in: RETENTION_ELIGIBLE_STATUSES },
    executionMode: { $in: RETENTION_LIVE_EXECUTION_MODES },
  }, { maxTimeMS: policy.queryMaxTimeMs })
  return {
    selectedCount: candidates.length,
    deletedCount: Number(result?.deletedCount || 0),
    stateProtected: candidates.length - deletable.length,
  }
}

export async function markExpiredCommandsForPurge({
  commandEvents = CommandEvent,
  auditEvents = AuditEvent,
  policy = commandRetentionPolicy(),
  now = new Date(),
} = {}) {
  if (!policy.enabled) return { candidateCount: 0, markedCount: 0, auditProtected: 0 }
  const candidates = []
  for (const status of RETENTION_ELIGIBLE_STATUSES) {
    const remaining = policy.batchSize - candidates.length
    if (remaining <= 0) break
    const cutoff = commandRetentionCutoff(status, { policy, now })
    if (!cutoff) continue
    const events = await commandEvents.find({
      status,
      executionMode: { $in: RETENTION_LIVE_EXECUTION_MODES },
      terminalAuditPending: false,
      purgeAt: { $exists: false },
      createdAt: { $lte: cutoff },
      completedAt: { $lte: cutoff },
    }).sort({ createdAt: 1 }).limit(remaining).maxTimeMS(policy.queryMaxTimeMs).lean()
    candidates.push(...events)
  }
  if (!candidates.length) return { candidateCount: 0, markedCount: 0, auditProtected: 0 }

  const audited = await auditedCommandKeys(candidates, auditEvents, policy.queryMaxTimeMs)
  const operations = []
  for (const event of candidates) {
    if (!audited.has(commandAuditKey(event))) continue
    const purgeAt = commandPurgeAt(event, { policy })
    if (!purgeAt || purgeAt > now) continue
    operations.push({
      updateOne: {
        filter: {
          _id: event._id,
          status: event.status,
          terminalAuditPending: false,
          purgeAt: { $exists: false },
        },
        update: { $set: { purgeAt } },
      },
    })
  }
  if (!operations.length) {
    return { candidateCount: candidates.length, markedCount: 0, auditProtected: candidates.length }
  }
  const result = await commandEvents.bulkWrite(operations, { ordered: false, maxTimeMS: policy.queryMaxTimeMs })
  const markedCount = Number(result?.modifiedCount ?? result?.nModified ?? 0)
  return {
    candidateCount: candidates.length,
    markedCount,
    auditProtected: candidates.length - operations.length,
  }
}

export async function acquireRetentionLease({
  leases = CommandRetentionLease,
  ownerId,
  now = new Date(),
  leaseMs = 120_000,
} = {}) {
  const leaseUntil = new Date(now.getTime() + leaseMs)
  try {
    const lease = await leases.findOneAndUpdate(
      {
        _id: LEASE_ID,
        $or: [
          { ownerId },
          { leaseUntil: { $lte: now } },
          { leaseUntil: { $exists: false } },
        ],
      },
      { $set: { ownerId, leaseUntil } },
      { upsert: true, new: true },
    ).lean()
    return lease?.ownerId === ownerId
  } catch (error) {
    if (Number(error?.code) === 11000) return false
    throw error
  }
}

export async function releaseRetentionLease({ leases = CommandRetentionLease, ownerId, now = new Date() } = {}) {
  if (!ownerId) return false
  const result = await leases.updateOne(
    { _id: LEASE_ID, ownerId },
    { $set: { leaseUntil: now } },
  )
  return Number(result?.modifiedCount || 0) > 0
}

export async function retentionIndexExists(commandEvents = CommandEvent) {
  try {
    const indexes = await commandEvents.collection.indexes()
    const index = indexes.find(candidate => candidate.name === COMMAND_RETENTION_INDEX)
    return Boolean(index?.key?.purgeAt === 1 && index?.partialFilterExpression?.purgeAt?.$exists === true)
  } catch (error) {
    if (Number(error?.code) === 26 || error?.codeName === 'NamespaceNotFound') return false
    throw error
  }
}

async function loadSnapshotKeys(events, tagValueSnapshots, maxTimeMS) {
  const pairs = [...new Map(events.map(event => [snapshotKey(event), {
    projectId: event.projectId,
    tagId: event.tagId,
  }])).values()]
  if (!pairs.length) return new Set()
  const snapshots = await tagValueSnapshots.find({ $or: pairs })
    .select({ projectId: 1, tagId: 1 })
    .maxTimeMS(maxTimeMS)
    .lean()
  return new Set(snapshots.map(snapshotKey))
}

async function auditedCommandKeys(events, auditEvents, maxTimeMS) {
  const correlationIds = [...new Set(events.map(event => event.correlationId).filter(Boolean))]
  if (!correlationIds.length) return new Set()
  const actions = [...new Set(events.map(event => `command.${event.status}`))]
  const audits = await auditEvents.find({ correlationId: { $in: correlationIds }, action: { $in: actions } })
    .select({ correlationId: 1, action: 1, metadata: 1 })
    .maxTimeMS(maxTimeMS)
    .lean()
  return new Set(audits.map(audit => `${audit.correlationId}:${audit.action}:${audit.metadata?.requestId || ''}`))
}

function commandAuditKey(event) {
  return `${event.correlationId}:command.${event.status}:${event.requestId}`
}

function snapshotKey(event) {
  return `${event.projectId}:${event.tagId}`
}
