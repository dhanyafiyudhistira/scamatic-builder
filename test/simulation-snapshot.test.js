import test from 'node:test'
import assert from 'node:assert/strict'
import { simulationSnapshotOperations } from '../shared/simulation-snapshot.js'

test('simulation snapshot updates accept only an equal or newer sequence', () => {
  const [operation] = simulationSnapshotOperations({
    schema: { tags: [{ id: 'valve.feedback', sourceId: 'tb', path: 'Valve', access: 'read', dataType: 'boolean' }] },
    telemetryValues: { Valve: true },
    workspaceId: 'workspace',
    projectId: 'project',
    timestamp: 1_700_000_000_000,
    receivedAt: new Date('2026-08-01T00:00:00.000Z'),
  })

  assert.equal(operation.updateOne.filter._id, 'project:valve.feedback')
  assert.equal(operation.updateOne.upsert, true)
  const fields = operation.updateOne.update[0].$set
  assert.deepEqual(fields.value.$cond[0], { $lte: [{ $ifNull: ['$sequence', -1] }, 1_700_000_000_000] })
  assert.deepEqual(fields.value.$cond[1], { $literal: true })
  assert.equal(fields.value.$cond[2], '$value')
  assert.deepEqual(fields.sequence.$cond[1], { $literal: 1_700_000_000_000 })
})
