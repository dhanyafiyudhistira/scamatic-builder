import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceSimulationValue, applySimulationRpc, simulationTelemetryBaseline, simulationTelemetryDelta, simulationTelemetryPayload } from '../shared/simulation-bridge.js'

function schema() {
  return {
    tags: [
      { id: 'cmd.v205', path: 'cmd.M_manualV205', dataType: 'boolean', access: 'write' },
      { id: 'valve.205', path: 'Valve_205', dataType: 'boolean', access: 'read' },
      { id: 'level.air', path: 'Level_Air', dataType: 'number', access: 'read-write' },
      { id: 'cmd.reset', path: 'cmd.Tombol_Reset', dataType: 'boolean', access: 'write' },
    ],
    components: [
      {
        id: 'control-v205',
        type: 'control-button',
        binding: { tagId: 'cmd.v205' },
        properties: { rpcMethod: 'setM_manualV205', feedbackTagId: 'valve.205', action: 'set-value', payload: true },
      },
      {
        id: 'control-level',
        type: 'tuning-slider',
        binding: { tagId: 'level.air' },
        properties: { rpcMethod: 'setLevel_Air', min: 0, max: 100, step: 1 },
      },
      {
        id: 'control-reset',
        type: 'control-button',
        binding: { tagId: 'cmd.reset' },
        properties: { rpcMethod: 'setTombol_Reset', action: 'pulse', pulseMs: 300 },
      },
    ],
  }
}

test('simulation telemetry publishes readable tag paths and never write-only commands', () => {
  assert.deepEqual(simulationTelemetryPayload(schema(), {
    'cmd.v205': true,
    'valve.205': true,
    'level.air': 42,
    'cmd.reset': false,
  }), {
    Valve_205: true,
    Level_Air: 42,
  })
})

test('simulation telemetry sends only changed readable values and permits an empty heartbeat payload', () => {
  assert.deepEqual(simulationTelemetryDelta(schema(), {
    'cmd.v205': true,
    'valve.205': true,
    'level.air': 42,
  }, {
    'valve.205': false,
    'level.air': 42,
  }), {
    'valve.205': true,
  })
  assert.deepEqual(simulationTelemetryPayload(schema(), {}, { allowEmpty: true }), {})
})

test('simulation reload seeds a silent telemetry baseline instead of publishing default outputs', () => {
  const hydrated = {
    'cmd.v205': false,
    'valve.205': true,
    'level.air': 42,
    'cmd.reset': false,
  }
  const baseline = simulationTelemetryBaseline(schema(), hydrated)
  assert.deepEqual(baseline, {
    'valve.205': true,
    'level.air': 42,
  })
  assert.deepEqual(simulationTelemetryDelta(schema(), hydrated, baseline), {})
  assert.deepEqual(simulationTelemetryDelta(schema(), { ...hydrated, 'valve.205': false }, baseline), {
    'valve.205': false,
  })
})

test('simulation process values stay still without a new target and ramp toward setpoint without overshoot', () => {
  assert.equal(advanceSimulationValue(25, 25, 5, .5), 25)
  assert.equal(advanceSimulationValue(25, 40, 5, .5), 27.5)
  assert.equal(advanceSimulationValue(39, 40, 5, .5), 40)
  assert.equal(advanceSimulationValue(40, 25, 5, .5), 37.5)
})

test('simulation RPC maps an external command to its readback tag', () => {
  const result = applySimulationRpc(schema(), { 'valve.205': false }, {
    id: 10,
    method: 'setM_manualV205',
    params: { value: true },
  })
  assert.equal(result.ok, true)
  assert.equal(result.changes['cmd.v205'], true)
  assert.equal(result.changes['valve.205'], true)
  assert.equal(result.response.status, 'acknowledged')
})

test('simulation RPC validates tuning payloads and rejects unknown methods', () => {
  assert.equal(applySimulationRpc(schema(), {}, { method: 'setLevel_Air', params: 41 }).changes['level.air'], 41)
  assert.equal(applySimulationRpc(schema(), {}, { method: 'setLevel_Air', params: 101 }).ok, false)
  assert.equal(applySimulationRpc(schema(), {}, { method: 'not-configured', params: true }).response.status, 'rejected')
})

test('simulation reset restores readable tags to their baseline', () => {
  const result = applySimulationRpc(schema(), { 'valve.205': true, 'level.air': 90 }, {
    id: 'reset-1',
    method: 'setTombol_Reset',
    params: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.changes['valve.205'], false)
  assert.equal(result.changes['level.air'], 0)
  assert.equal(result.resetAfterMs, 300)
})

test('Simulation Bridge Operation Shifter reset drives supervised boolean feedback to steady off', () => {
  const operationSchema = schema()
  operationSchema.tags.push({ id: 'mode', path: 'Operation_Mode', dataType: 'enum', access: 'read-write' })
  operationSchema.components.push({
    id: 'operation',
    type: 'operation-shifter',
    binding: { tagId: 'mode' },
    properties: { rpcMethod: 'setOperationMode', controlledComponentIds: ['control-v205'], autoSequence: [] },
  })
  const result = applySimulationRpc(operationSchema, { 'valve.205': true, mode: 'manual' }, {
    id: 'mode-reset', method: 'setOperationMode', params: { mode: 'reset' },
  })
  assert.equal(result.ok, true)
  assert.equal(result.changes.mode, 'reset')
  assert.equal(result.changes['valve.205'], false)
  assert.equal(result.operation.steady, true)
})
