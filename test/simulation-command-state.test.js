import test from 'node:test'
import assert from 'node:assert/strict'
import { newestSimulationSample, previousSimulationCommandValue, reconcileSimulationControlState, simulationCommandHistoryRequired, simulationCommandReadScope, simulationCommandState } from '../shared/simulation-command-state.js'

const schema = {
  tags: [
    { id: 'mode.command', dataType: 'enum', access: 'write' },
    { id: 'mode.feedback', dataType: 'enum', access: 'read' },
    { id: 'valve.command', dataType: 'boolean', access: 'write' },
    { id: 'valve.feedback', dataType: 'boolean', access: 'read' },
  ],
  components: [
    { id: 'valve', type: 'control-button', binding: { tagId: 'valve.command' }, properties: { feedbackTagId: 'valve.feedback', action: 'toggle-boolean' } },
    { id: 'operation', type: 'operation-shifter', binding: { tagId: 'mode.command' }, properties: { feedbackTagId: 'mode.feedback', controlledComponentIds: ['valve'] } },
  ],
}

const acknowledged = {
  status: 'acknowledged',
  executionMode: 'mock',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
}

test('a newer simulation RESET becomes the persisted OFF baseline for supervised buttons', () => {
  const commands = [
    { ...acknowledged, componentId: 'operation', tagId: 'mode.command', resultSummary: { value: { mode: 'reset' } } },
    { ...acknowledged, componentId: 'valve', tagId: 'valve.command', resultSummary: { value: true } },
  ]
  const state = simulationCommandState(schema, commands)
  assert.equal(state.get('valve.command').value, false)
  assert.equal(state.get('valve.feedback').value, false)
  assert.equal(state.get('mode.command').value, 'reset')
  assert.equal(state.get('mode.feedback').value, 'reset')
  assert.equal(previousSimulationCommandValue(schema, commands, schema.components[0], schema.tags[2]), false)
})

test('a button command newer than RESET remains authoritative', () => {
  const commands = [
    { ...acknowledged, componentId: 'valve', tagId: 'valve.command', resultSummary: { value: true } },
    { ...acknowledged, componentId: 'operation', tagId: 'mode.command', resultSummary: { value: { mode: 'reset' } } },
  ]
  const state = simulationCommandState(schema, commands)
  assert.equal(state.get('valve.command').value, true)
  assert.equal(state.get('valve.feedback').value, true)
})

test('toggle history reads only its own command and supervising RESET effects', () => {
  assert.deepEqual(simulationCommandReadScope(schema, schema.components[0], schema.tags[2]), {
    componentId: 'valve',
    tagId: 'valve.command',
    resetComponentIds: ['operation'],
  })
  assert.equal(simulationCommandReadScope(schema, schema.components[1], schema.tags[0]), null)
})

test('the newest relevant toggle effect is sufficient to reconstruct its previous value', () => {
  const newestButton = { ...acknowledged, componentId: 'valve', tagId: 'valve.command', resultSummary: { value: true } }
  const newestReset = { ...acknowledged, componentId: 'operation', tagId: 'mode.command', resultSummary: { value: { mode: 'reset' } } }
  assert.equal(previousSimulationCommandValue(schema, [newestButton], schema.components[0], schema.tags[2]), true)
  assert.equal(previousSimulationCommandValue(schema, [newestReset], schema.components[0], schema.tags[2]), false)
})

test('an explicit toggle intent does not reload history that cannot affect its result', () => {
  assert.equal(simulationCommandHistoryRequired(schema.components[0], undefined), true)
  assert.equal(simulationCommandHistoryRequired(schema.components[0], true), false)
  assert.equal(simulationCommandHistoryRequired(schema.components[0], false), false)
  assert.equal(simulationCommandHistoryRequired(schema.components[1], undefined), false)
})

test('bootstrap keeps the newest state across snapshot and command history', () => {
  const snapshot = { value: false, timestamp: '2026-08-01T00:00:00.000Z' }
  const restored = { value: true, timestamp: '2026-08-01T00:00:01.000Z' }
  assert.equal(newestSimulationSample(snapshot, restored), restored)
  assert.equal(newestSimulationSample(restored, snapshot), restored)
})

test('bootstrap mirrors readable feedback into a toggle command intent', () => {
  const feedback = { value: true, timestamp: '2026-08-01T00:00:00.000Z', quality: 'good' }
  const reconciled = reconcileSimulationControlState(schema, {
    'valve.command': { value: false, timestamp: '2026-07-31T23:59:59.000Z', quality: 'good' },
    'valve.feedback': feedback,
  })
  assert.deepEqual(reconciled['valve.command'], feedback)
  assert.notEqual(reconciled['valve.command'], feedback)
})
