import test from 'node:test'
import assert from 'node:assert/strict'
import { connectorDeletionBlock, connectorSourceUsage, detachUnusedConnectorSources } from '../shared/connector-lifecycle.js'

test('connector source usage counts only tags belonging to the selected connector', () => {
  const schema = sampleSchema()
  assert.deepEqual(connectorSourceUsage(schema, 'connector-old'), { attached: true, sourceIds: ['source-old'], tagCount: 0 })
  assert.deepEqual(connectorSourceUsage(schema, 'connector-live'), { attached: true, sourceIds: ['source-live'], tagCount: 1 })
})

test('unused connector sources detach without changing mock or active sources', () => {
  const result = detachUnusedConnectorSources(sampleSchema(), 'connector-old')
  assert.equal(result.ok, true)
  assert.deepEqual(result.schema.dataSources.map(source => source.id), ['source_mock', 'source-live'])
  assert.equal(result.schema.tags[0].sourceId, 'source-live')
})

test('connector sources with tag bindings cannot detach', () => {
  const schema = sampleSchema()
  const result = detachUnusedConnectorSources(schema, 'connector-live')
  assert.equal(result.ok, false)
  assert.equal(result.usage.tagCount, 1)
  assert.equal(result.schema, schema)
})

test('connector deletion depends on active draft state, not immutable published history', () => {
  assert.deepEqual(connectorDeletionBlock({ enabled: true }), {
    code: 'CONNECTOR_ENABLED',
    message: 'Disable the connector before deleting it.',
  })
  assert.deepEqual(connectorDeletionBlock({ draftAttached: true }), {
    code: 'CONNECTOR_IN_DRAFT',
    message: 'Detach the connector from the saved draft before deleting it.',
  })
  assert.deepEqual(connectorDeletionBlock({ draftDirty: true }), {
    code: 'DRAFT_DIRTY',
    message: 'Save the draft before deleting the connector.',
  })
  assert.equal(connectorDeletionBlock(), null)
})

function sampleSchema() {
  return {
    dataSources: [
      { id: 'source_mock', type: 'mock', connectorRef: null },
      { id: 'source-old', type: 'thingsboard', connectorRef: 'connector-old' },
      { id: 'source-live', type: 'thingsboard', connectorRef: 'connector-live' },
    ],
    tags: [{ id: 'level', sourceId: 'source-live' }],
  }
}
