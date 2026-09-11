import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'
import { applyDiscoveredThingsBoardTags } from '../shared/thingsboard-discovery.js'

test('telemetry discovery creates canonical tags and skips existing paths', () => {
  const schema = createProjectSchema({ id: 'project-1', name: 'IoT', slug: 'iot', projectType: 'iot-dashboard' })
  schema.dataSources.push({ id: 'source_tb_1', type: 'thingsboard', environmentRef: 'staging', connectorRef: 'connector-1' })
  schema.tags.push({ id: 'tag_pressure', name: 'Pressure', path: 'pressure', dataType: 'number', access: 'read', sourceId: 'source_tb_1', numberFormat: 'number', engineering: { min: 0, max: 100, unit: '', decimals: 1 } })
  const result = applyDiscoveredThingsBoardTags(schema, { connectorId: 'connector-1', keys: [{ key: 'pressure', dataType: 'number' }, { key: 'motorRunning', dataType: 'boolean' }, { key: 'temperature', dataType: 'number' }] })
  assert.deepEqual(result.stats, { created: 2, skipped: 1 })
  assert.equal(result.tags[0].sourceId, 'source_tb_1')
  assert.equal(result.tags[0].access, 'read')
  assert.equal(result.tags[1].engineering.max, 100)
  assert.equal(validateProjectSchema(result.schema).filter(issue => issue.severity === 'error').length, 0)
})
