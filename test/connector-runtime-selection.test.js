import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectSchema } from '../shared/project-schema.js'
import { selectConnectorRuntimeSchema } from '../server/connectors/runtime-schema-selection.js'

const connector = { _id: 'connector-1', projectId: 'project-1', type: 'thingsboard' }

test('published connector schema takes priority over a newer draft', () => {
  const publishedSchema = thingsBoardSchema({ path: 'Published_Level' })
  const draftSchema = thingsBoardSchema({ path: 'Draft_Level' })
  const selected = selectConnectorRuntimeSchema({
    connector,
    environmentRef: 'staging',
    publishedVersion: { _id: 'version-7', schema: publishedSchema },
    draft: { revision: 99, updatedAt: '2026-07-22T12:00:00.000Z', schema: draftSchema },
  })

  assert.equal(selected.mode, 'published')
  assert.equal(selected.bindings[0].path, 'Published_Level')
  assert.equal(selected.fingerprint, 'published:version-7')
})

test('a valid saved draft bootstraps read bindings without exposing write-only tags', () => {
  const draftSchema = thingsBoardSchema({ path: 'Level_Air' })
  draftSchema.tags.push({ id: 'command', name: 'Command', path: 'cmd.Level_Air', dataType: 'number', access: 'write', sourceId: 'source_tb', staleAfterMs: 10_000 })
  const selected = selectConnectorRuntimeSchema({
    connector,
    environmentRef: 'staging',
    publishedVersion: { _id: 'version-mock', schema: mockOnlySchema() },
    draft: { revision: 158, updatedAt: '2026-07-22T15:32:38.000Z', schema: draftSchema },
  })

  assert.equal(selected.mode, 'bootstrap')
  assert.deepEqual(selected.bindings.map(tag => tag.id), ['level'])
  assert.equal(selected.fingerprint, 'bootstrap:158:2026-07-22T15:32:38.000Z')
})

test('invalid, cross-project, and write-only drafts cannot bootstrap a connector', () => {
  const invalid = thingsBoardSchema({ path: '' })
  assert.equal(selectConnectorRuntimeSchema({ connector, environmentRef: 'staging', draft: { revision: 2, schema: invalid } }), null)

  const crossProject = thingsBoardSchema({ path: 'Level_Air', projectId: 'project-2' })
  assert.equal(selectConnectorRuntimeSchema({ connector, environmentRef: 'staging', draft: { revision: 3, schema: crossProject } }), null)

  const writeOnly = thingsBoardSchema({ path: 'cmd.Level_Air', access: 'write' })
  assert.equal(selectConnectorRuntimeSchema({ connector, environmentRef: 'staging', draft: { revision: 4, schema: writeOnly } }), null)
})

function thingsBoardSchema({ path, access = 'read', projectId = 'project-1' }) {
  const schema = createProjectSchema({ id: projectId, name: 'RWT', slug: 'rwt' })
  schema.dataSources.push({ id: 'source_tb', type: 'thingsboard', environmentRef: 'staging', connectorRef: 'connector-1' })
  schema.tags.push({ id: 'level', name: 'Level', path, dataType: 'number', access, sourceId: 'source_tb', staleAfterMs: 10_000 })
  return schema
}

function mockOnlySchema() {
  return createProjectSchema({ id: 'project-1', name: 'RWT', slug: 'rwt' })
}
