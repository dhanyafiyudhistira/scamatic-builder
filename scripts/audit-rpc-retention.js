import 'dotenv/config'
import { connectMongo, disconnectMongo } from '../api/_lib/mongo.js'
import { CommandEvent } from '../api/_lib/models.js'
import {
  commandRetentionCutoff,
  commandRetentionPolicy,
  RETENTION_ACTIVE_STATUSES,
  RETENTION_ELIGIBLE_STATUSES,
  RETENTION_LIVE_EXECUTION_MODES,
} from '../shared/command-retention.js'
import { COMMAND_RETENTION_INDEX } from '../server/connectors/command-retention-janitor.js'

const environment = { ...process.env, COMMAND_RETENTION_ENABLED: 'true' }
const policy = commandRetentionPolicy(environment)
const projectId = String(process.env.RPC_RETENTION_AUDIT_PROJECT_ID || '').trim()
const scope = projectId ? { projectId } : {}
const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  scope: projectId ? { projectId } : 'all-projects',
  policy: {
    acknowledgedDays: policy.acknowledgedDays,
    failureDays: policy.failureDays,
    batchSize: policy.batchSize,
    queryMaxTimeMs: policy.queryMaxTimeMs,
    timeoutPolicy: 'protected-indefinitely',
    simulationPolicy: 'protected-indefinitely',
  },
  collection: {},
  safety: {},
  eligibleAfterAuditVerification: {},
  warnings: [],
}

try {
  const connection = await connectMongo()
  report.collection.name = CommandEvent.collection.name
  report.collection.estimatedDocuments = await CommandEvent.estimatedDocumentCount().maxTimeMS(policy.queryMaxTimeMs)
  if (projectId) report.collection.scopedDocuments = await boundedCount(scope)
  const indexes = await CommandEvent.collection.indexes().catch(error => {
    if (Number(error?.code) === 26 || error?.codeName === 'NamespaceNotFound') return []
    throw error
  })
  const purgeIndex = indexes.find(index => index.name === COMMAND_RETENTION_INDEX)
  report.collection.purgeIndexPresent = Boolean(purgeIndex?.key?.purgeAt === 1 && purgeIndex?.partialFilterExpression?.purgeAt?.$exists === true)
  try {
    const stats = await connection.connection.db.command({ collStats: CommandEvent.collection.name, scale: 1 })
    report.collection.storageBytes = numberOrNull(stats.storageSize)
    report.collection.totalIndexBytes = numberOrNull(stats.totalIndexSize)
    report.collection.averageDocumentBytes = numberOrNull(stats.avgObjSize)
  } catch (error) {
    report.warnings.push(`Collection size statistics unavailable: ${safeCode(error)}`)
  }

  report.safety.activeCommands = await boundedCount({ ...scope, status: { $in: RETENTION_ACTIVE_STATUSES } })
  report.safety.terminalAuditPending = await boundedCount({ ...scope, terminalAuditPending: true })
  report.safety.ambiguousTimeouts = await boundedCount({ ...scope, status: 'timeout' })
  report.safety.simulationCommands = await boundedCount({ ...scope, executionMode: 'mock' })

  for (const status of RETENTION_ELIGIBLE_STATUSES) {
    const cutoff = commandRetentionCutoff(status, { policy, now: new Date() })
    report.eligibleAfterAuditVerification[status] = await boundedCount({
      ...scope,
      status,
      executionMode: { $in: RETENTION_LIVE_EXECUTION_MODES },
      terminalAuditPending: false,
      completedAt: { $lte: cutoff },
    })
  }
} catch (error) {
  report.error = { code: safeCode(error), message: String(error?.message || 'RPC retention audit failed.').slice(0, 240) }
  process.exitCode = 1
} finally {
  console.log(JSON.stringify(report, null, 2))
  await disconnectMongo().catch(() => {})
}

async function boundedCount(filter) {
  try {
    return await CommandEvent.countDocuments(filter).maxTimeMS(policy.queryMaxTimeMs)
  } catch (error) {
    report.warnings.push(`Bounded count timed out or failed (${safeCode(error)}).`)
    return null
  }
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function safeCode(error) {
  return String(error?.code || error?.codeName || error?.name || 'UNKNOWN').slice(0, 80)
}
