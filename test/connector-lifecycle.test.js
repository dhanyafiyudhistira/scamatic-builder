import test from 'node:test'
import assert from 'node:assert/strict'
import { connectorSourceUsage, detachUnusedConnectorSources } from '../shared/connector-lifecycle.js'

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
