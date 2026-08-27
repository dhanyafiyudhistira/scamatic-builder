import 'dotenv/config'
import { connectMongo, disconnectMongo } from '../api/_lib/mongo.js'
import { CommandEvent } from '../api/_lib/models.js'
import { COMMAND_RETENTION_INDEX } from '../server/connectors/command-retention-janitor.js'

const apply = process.argv.includes('--apply')

try {
  await connectMongo()
  const indexes = await CommandEvent.collection.indexes().catch(error => {
    if (Number(error?.code) === 26 || error?.codeName === 'NamespaceNotFound') return []
    throw error
  })
  const existing = indexes.find(index => index.name === COMMAND_RETENTION_INDEX)
  const exists = existing?.key?.purgeAt === 1 && existing?.partialFilterExpression?.purgeAt?.$exists === true
  if (existing && !exists) throw new Error(`${COMMAND_RETENTION_INDEX} exists with an unexpected definition.`)
  if (exists) {
    console.log(`[RetentionMigration] ${COMMAND_RETENTION_INDEX} already exists; no changes required.`)
  } else if (!apply) {
    console.log(`[RetentionMigration] Planned index: ${COMMAND_RETENTION_INDEX} on { purgeAt: 1 } with an existence-only partial filter.`)
    console.log('[RetentionMigration] No changes applied. Re-run with --apply during a quiet database period.')
  } else {
    await CommandEvent.collection.createIndex(
      { purgeAt: 1 },
      {
        name: COMMAND_RETENTION_INDEX,
        partialFilterExpression: { purgeAt: { $exists: true } },
      },
    )
    console.log(`[RetentionMigration] ${COMMAND_RETENTION_INDEX} created successfully.`)
  }
} finally {
  await disconnectMongo()
}
