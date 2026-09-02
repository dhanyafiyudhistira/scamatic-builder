import assert from 'node:assert/strict'
import test from 'node:test'
import { auditMasterKeyCompatibility } from '../api/_lib/master-key-compatibility.js'
import {
  encryptChartStorageSecret,
  encryptConnectorSecret,
  rewrapChartStorageSecretKey,
  rewrapConnectorSecretKey,
} from '../api/_lib/connector-secrets.js'

test('master-key audit detects fallback records and verifies rewrap completion', async () => {
  const originalPrimary = process.env.SCADA_CONNECTOR_MASTER_KEY
  const originalPrevious = process.env.SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS
  const oldKey = Buffer.alloc(32, 4).toString('hex')
  const newKey = Buffer.alloc(32, 8).toString('hex')
  try {
    process.env.SCADA_CONNECTOR_MASTER_KEY = oldKey
    delete process.env.SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS
    const connector = {
      _id: 'connector-secret',
      connectorId: 'connector-a',
      environmentRef: 'staging',
      ...encryptConnectorSecret({ jwt: 'connector-secret-value' }, { connectorId: 'connector-a', environmentRef: 'staging' }),
    }
    const chart = {
      _id: 'chart-secret',
      workspaceId: 'workspace-a',
      ...encryptChartStorageSecret({ uri: 'mongodb://archive.example/telemetry' }, { workspaceId: 'workspace-a' }),
    }

    process.env.SCADA_CONNECTOR_MASTER_KEY = newKey
    delete process.env.SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS
    const incompatible = await auditMasterKeyCompatibility({ connectorModel: fakeModel([connector]), chartStorageModel: fakeModel([chart]) })
    assert.equal(incompatible.ok, false)
    assert.equal(incompatible.incompatible, 2)

    process.env.SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS = oldKey
    const transitional = await auditMasterKeyCompatibility({ connectorModel: fakeModel([connector]), chartStorageModel: fakeModel([chart]) })
    assert.equal(transitional.ok, true)
    assert.equal(transitional.rotationRequired, 2)

    const rotatedConnector = { ...connector, ...rewrapConnectorSecretKey(connector, { connectorId: connector.connectorId, environmentRef: connector.environmentRef }) }
    const rotatedChart = { ...chart, ...rewrapChartStorageSecretKey(chart, { workspaceId: chart.workspaceId }) }
    delete process.env.SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS
    const completed = await auditMasterKeyCompatibility({ connectorModel: fakeModel([rotatedConnector]), chartStorageModel: fakeModel([rotatedChart]) })
    assert.equal(completed.ok, true)
    assert.equal(completed.rotationRequired, 0)
  } finally {
    if (originalPrimary == null) delete process.env.SCADA_CONNECTOR_MASTER_KEY
    else process.env.SCADA_CONNECTOR_MASTER_KEY = originalPrimary
    if (originalPrevious == null) delete process.env.SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS
    else process.env.SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS = originalPrevious
  }
})

function fakeModel(records) {
  return {
    find() {
      return {
        select() {
          return { lean: async () => records }
        },
      }
    },
  }
}
