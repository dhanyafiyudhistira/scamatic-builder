import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSimulationSequencePlan, resolveSimulationSequenceStep } from '../shared/simulation-sequence.js'

function schema() {
  return {
    tags: [
      { id: 'mode.command', dataType: 'enum', access: 'write' },
      { id: 'valve.command', dataType: 'boolean', access: 'write' },
      { id: 'valve.feedback', dataType: 'boolean', access: 'read' },
      { id: 'pump.command', dataType: 'boolean', access: 'read-write' },
    ],
    components: [
      {
        id: 'valve-button',
        type: 'control-button',
        name: 'Valve',
        binding: { tagId: 'valve.command' },
        properties: { rpcMethod: 'setValve', feedbackTagId: 'valve.feedback' },
      },
      {
        id: 'pump-button',
        type: 'control-button',
        name: 'Pump',
        binding: { tagId: 'pump.command' },
        properties: { rpcMethod: 'setPump' },
      },
      {
        id: 'operation',
        type: 'operation-shifter',
        binding: { tagId: 'mode.command' },
        properties: {
          rpcMethod: 'setOperationMode',
          controlledComponentIds: ['valve-button', 'pump-button'],
          autoSequence: [
            { id: 'open-valve', componentId: 'valve-button', value: true, delayMs: 500, enabled: true },
            { id: 'stop-pump', componentId: 'pump-button', value: false, delayMs: 750, enabled: true },
          ],
        },
      },
    ],
  }
}

test('simulation sequence plan contains only the operator-selected recipe steps', () => {
  const plan = buildSimulationSequencePlan(schema(), 'operation', ['stop-pump'])
  assert.deepEqual(plan.steps, [{
    id: 'stop-pump',
    order: 2,
    componentId: 'pump-button',
    rpcMethod: 'setPump',
    value: false,
    delayMs: 750,
  }])
})

test('simulation sequence step drives the referenced button command and feedback tags', () => {
  const valve = resolveSimulationSequenceStep(schema(), 'operation', 'open-valve', ['open-valve'])
  assert.equal(valve.component.id, 'valve-button')
  assert.deepEqual(valve.changes, { 'valve.command': true, 'valve.feedback': true })

  const pump = resolveSimulationSequenceStep(schema(), 'operation', 'stop-pump', ['stop-pump'])
  assert.deepEqual(pump.changes, { 'pump.command': false })
})

test('simulation sequence cannot execute a recipe step excluded by the operator', () => {
  assert.throws(
    () => resolveSimulationSequenceStep(schema(), 'operation', 'open-valve', ['stop-pump']),
    error => error.code === 'SIMULATION_SEQUENCE_STEP_INVALID',
  )
})
