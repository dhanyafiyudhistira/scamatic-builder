import { ChartStorageSecret, ConnectorSecret } from './models.js'
import { configuredMasterKeyMetadata, inspectChartStorageSecretKey, inspectConnectorSecretKey } from './connector-secrets.js'

const SECRET_FIELDS = '+payloadCiphertext +payloadIv +payloadTag +wrappedKey +wrappedKeyIv +wrappedKeyTag +keyVersion'

export async function auditMasterKeyCompatibility({ connectorModel = ConnectorSecret, chartStorageModel = ChartStorageSecret } = {}) {
  const metadata = configuredMasterKeyMetadata()
  const [connectorRecords, chartRecords] = await Promise.all([
    connectorModel.find({}).select(SECRET_FIELDS).lean(),
    chartStorageModel.find({}).select(SECRET_FIELDS).lean(),
  ])
  let compatible = 0
  let incompatible = 0
  let rotationRequired = 0

  for (const record of connectorRecords) {
    try {
      const result = inspectConnectorSecretKey(record, { connectorId: record.connectorId, environmentRef: record.environmentRef })
      compatible += 1
      if (!result.primary || result.wrappingKeyId !== metadata.primaryKeyId || !record.wrappingKeyId) rotationRequired += 1
    } catch (error) {
      if (error?.code !== 'CONNECTOR_KEY_MISMATCH') throw error
      incompatible += 1
    }
  }
  for (const record of chartRecords) {
    try {
      const result = inspectChartStorageSecretKey(record, { workspaceId: record.workspaceId })
      compatible += 1
      if (!result.primary || result.wrappingKeyId !== metadata.primaryKeyId || !record.wrappingKeyId) rotationRequired += 1
    } catch (error) {
      if (error?.code !== 'CONNECTOR_KEY_MISMATCH') throw error
      incompatible += 1
    }
  }

  const checked = connectorRecords.length + chartRecords.length
  return {
    ok: incompatible === 0,
    status: incompatible ? 'incompatible' : rotationRequired ? 'rotation-required' : checked ? 'compatible' : 'empty',
    checked,
    compatible,
    incompatible,
    rotationRequired,
  }
}
