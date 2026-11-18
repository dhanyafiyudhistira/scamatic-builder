import { ChartStorageSecret, ConnectorSecret } from './models.js'
import { configuredMasterKeyMetadata, inspectChartStorageSecretKey, inspectConnectorSecretKey } from './connector-secrets.js'

const SECRET_FIELDS = '+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion'
const DEFAULT_CACHE_TTL_MS = 30_000

export async function auditMasterKeyCompatibility({ connectorModel = ConnectorSecret, chartStorageModel = ChartStorageSecret } = {}) {
  const metadata = configuredMasterKeyMetadata()
  let checked = 0
  let compatible = 0
  let incompatible = 0
  let rotationRequired = 0

  for await (const record of secretRecords(connectorModel)) {
    checked += 1
    try {
      const result = inspectConnectorSecretKey(record, { connectorId: record.connectorId, environmentRef: record.environmentRef })
      compatible += 1
      if (!result.primary || result.wrappingKeyId !== metadata.primaryKeyId || !record.wrappingKeyId) rotationRequired += 1
    } catch (error) {
      if (error?.code !== 'CONNECTOR_KEY_MISMATCH') throw error
      incompatible += 1
    }
  }
  for await (const record of secretRecords(chartStorageModel)) {
    checked += 1
    try {
      const result = inspectChartStorageSecretKey(record, { workspaceId: record.workspaceId })
      compatible += 1
      if (!result.primary || result.wrappingKeyId !== metadata.primaryKeyId || !record.wrappingKeyId) rotationRequired += 1
    } catch (error) {
      if (error?.code !== 'CONNECTOR_KEY_MISMATCH') throw error
      incompatible += 1
    }
  }

  return {
    ok: incompatible === 0,
    status: incompatible ? 'incompatible' : rotationRequired ? 'rotation-required' : checked ? 'compatible' : 'empty',
    checked,
    compatible,
    incompatible,
    rotationRequired,
  }
}

export function createMasterKeyCompatibilityCache({
  audit = auditMasterKeyCompatibility,
  ttlMs = DEFAULT_CACHE_TTL_MS,
  now = Date.now,
} = {}) {
  const cacheTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0
  let cachedResult = null
  let expiresAt = 0
  let inFlight = null

  return function cachedMasterKeyCompatibilityAudit() {
    if (cachedResult && now() < expiresAt) return Promise.resolve(cachedResult)
    if (inFlight) return inFlight

    inFlight = Promise.resolve()
      .then(() => audit())
      .then(result => {
        cachedResult = result
        expiresAt = now() + cacheTtlMs
        return result
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }
}

function secretRecords(model) {
  return model.find({}).select(SECRET_FIELDS).lean().cursor()
}
