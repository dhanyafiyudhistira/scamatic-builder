import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import dotenv from 'dotenv'
import { connectMongo, disconnectMongo, runMongoTransaction } from '../api/_lib/mongo.js'
import { ChartStorageSecret, ConnectorSecret } from '../api/_lib/models.js'
import {
  configuredMasterKeyMetadata,
  inspectChartStorageSecretKey,
  inspectConnectorSecretKey,
  rewrapChartStorageSecretKey,
  rewrapConnectorSecretKey,
} from '../api/_lib/connector-secrets.js'
import { auditMasterKeyCompatibility } from '../api/_lib/master-key-compatibility.js'

const SECRET_FIELDS = '+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion'

async function main() {
  const options = parseOptions(process.argv.slice(2))
  await loadMachineEnvironment(options.config)
  const metadata = configuredMasterKeyMetadata()
  if (metadata.configuredKeyCount < 2) {
    throw new Error('Rotation requires a new SCADA_CONNECTOR_MASTER_KEY and the old key in SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS.')
  }

  await connectMongo()
  const before = await auditMasterKeyCompatibility()
  printSummary(options.apply ? 'preflight' : 'dry-run', before)
  if (!before.ok) throw new Error('At least one encrypted record cannot be unwrapped by the configured primary or previous keys. No records were changed.')
  if (!options.apply) {
    console.log('Dry run only. Stop SCAMATICRuntime and repeat with --apply to rotate the wrapping keys.')
    return
  }
  assertServiceStopped()

  const [connectorRecords, chartRecords] = await Promise.all([
    ConnectorSecret.find({}).select(SECRET_FIELDS).lean(),
    ChartStorageSecret.find({}).select(SECRET_FIELDS).lean(),
  ])
  const connectorOperations = connectorRecords.flatMap(record => {
    const inspected = inspectConnectorSecretKey(record, { connectorId: record.connectorId, environmentRef: record.environmentRef })
    if (inspected.primary && record.wrappingKeyId === metadata.primaryKeyId) return []
    return [{
      updateOne: {
        filter: { _id: record._id },
        update: { $set: rewrapConnectorSecretKey(record, { connectorId: record.connectorId, environmentRef: record.environmentRef }) },
      },
    }]
  })
  const chartOperations = chartRecords.flatMap(record => {
    const inspected = inspectChartStorageSecretKey(record, { workspaceId: record.workspaceId })
    if (inspected.primary && record.wrappingKeyId === metadata.primaryKeyId) return []
    return [{
      updateOne: {
        filter: { _id: record._id },
        update: { $set: rewrapChartStorageSecretKey(record, { workspaceId: record.workspaceId }) },
      },
    }]
  })

  await runMongoTransaction(async session => {
    const options = session ? { session, ordered: false } : { ordered: false }
    if (connectorOperations.length) await ConnectorSecret.bulkWrite(connectorOperations, options)
    if (chartOperations.length) await ChartStorageSecret.bulkWrite(chartOperations, options)
  })
  const after = await auditMasterKeyCompatibility()
  printSummary('completed', after)
  if (!after.ok || after.rotationRequired !== 0) throw new Error('Post-rotation verification failed. Keep the previous key configured and investigate before restarting the service.')
  console.log('Rotation verified. Remove SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS from runtime.env, then start SCAMATICRuntime.')
}

function parseOptions(arguments_) {
  const options = { apply: false, config: defaultConfigPath() }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--apply') options.apply = true
    else if (argument === '--config') options.config = arguments_[++index]
    else throw new Error(`Unknown option: ${argument}`)
  }
  if (!options.config) throw new Error('--config requires a path')
  return options
}

function defaultConfigPath() {
  const root = process.env.ProgramData || 'C:\\ProgramData'
  return `${root}\\SCAMATIC\\runtime.env`
}

async function loadMachineEnvironment(path) {
  const parsed = dotenv.parse(await readFile(path, 'utf8'))
  for (const [key, value] of Object.entries(parsed)) process.env[key] = value
}

function assertServiceStopped() {
  if (process.platform !== 'win32') return
  let output = ''
  try {
    output = execFileSync('sc.exe', ['query', 'SCAMATICRuntime'], { encoding: 'utf8', windowsHide: true })
  } catch (error) {
    output = String(error?.stdout || '')
  }
  if (!/STATE\s*:\s*1\s+STOPPED/i.test(output)) {
    throw new Error('Stop the SCAMATICRuntime Windows Service before applying master-key rotation.')
  }
}

function printSummary(stage, result) {
  console.log(JSON.stringify({
    stage,
    ok: result.ok,
    status: result.status,
    checked: result.checked,
    incompatible: result.incompatible,
    rotationRequired: result.rotationRequired,
  }))
}

main()
  .catch(error => {
    console.error(`Master-key rotation failed: ${error.message}`)
    process.exitCode = 1
  })
  .finally(() => disconnectMongo().catch(() => {}))
