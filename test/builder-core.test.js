import test from 'node:test'
import assert from 'node:assert/strict'
import { compatibleTags, createComponentInstance } from '../shared/component-registry.js'
import { commandUiState, evaluateOperationShift, evaluateRule, executeMockCommand, formatRuntimeValue, tuningInteractionState, valueSeverity } from '../shared/runtime-evaluator.js'
import { validateProjectSchema } from '../shared/project-schema.js'
import { describeVersion, nextVersionNumber, restoredFromVersionNumber } from '../shared/version-history.js'
import { auditActionCategory, auditActionLabel } from '../shared/audit-display.js'

const canvas = { width: 1920, height: 1080 }

test('component registry creates all MVP component types with logical positions', () => {
  for (const type of ['indicator-lamp', 'value-span', 'control-button', 'tuning-slider', 'operation-shifter', 'control-popup', 'chart', 'text-label']) {
    const component = createComponentInstance(type, { id: `id-${type}`, canvas, index: 0 })
    assert.equal(component.type, type)
    assert.ok(component.position.width > 0)
    assert.ok(component.position.x >= 0)
    assert.equal(component.visible, true)
  }
})

test('registry filters compatible tags by component type', () => {
  const tags = [
    { id: 'bool', dataType: 'boolean' },
    { id: 'number', dataType: 'number' },
    { id: 'mode', dataType: 'enum' },
    { id: 'date', dataType: 'datetime' },
  ]
  assert.deepEqual(compatibleTags('indicator-lamp', tags).map(tag => tag.id), ['bool', 'number', 'mode'])
  assert.deepEqual(compatibleTags('value-span', tags).map(tag => tag.id), ['number', 'mode', 'date'])
  assert.deepEqual(compatibleTags('tuning-slider', tags).map(tag => tag.id), ['number'])
  assert.deepEqual(compatibleTags('operation-shifter', tags).map(tag => tag.id), ['mode'])
  assert.deepEqual(compatibleTags('chart', tags).map(tag => tag.id), ['number'])
  assert.deepEqual(compatibleTags('text-label', tags), [])
  assert.deepEqual(compatibleTags('control-popup', tags), [])
})

test('Operation Shifter keeps independent dark and light board palettes', () => {
  const shifter = createComponentInstance('operation-shifter', { id: 'shift-colors', canvas, index: 0 })
  assert.deepEqual({
    dark: [shifter.properties.darkButtonBackground, shifter.properties.darkButtonText, shifter.properties.darkButtonBorder],
    light: [shifter.properties.lightButtonBackground, shifter.properties.lightButtonText, shifter.properties.lightButtonBorder],
  }, {
    dark: ['#151719', '#f0f3f4', '#3d4246'],
    light: ['#e9ece9', '#172229', '#747f85'],
  })
})

test('Operation Shifter builds a bounded edge-executed recipe and reset payload', () => {
  const shifter = createComponentInstance('operation-shifter', { id: 'shift', canvas, tagId: 'mode', index: 0 })
  const valveA = createComponentInstance('control-button', { id: 'valve-a', canvas, tagId: 'a', index: 1 })
  const valveB = createComponentInstance('control-button', { id: 'valve-b', canvas, tagId: 'b', index: 2 })
  valveA.properties.rpcMethod = 'setValveA'
  valveB.properties.rpcMethod = 'setValveB'
  shifter.properties.controlledComponentIds = ['valve-a', 'valve-b']
  shifter.properties.autoSequence = [
    { id: 'open-a', componentId: 'valve-a', value: true, delayMs: 500, enabled: true },
    { id: 'close-b', componentId: 'valve-b', value: false, delayMs: 1500, enabled: true },
  ]
  const tag = { access: 'write', dataType: 'enum' }
  const automatic = evaluateOperationShift(shifter, tag, { mode: 'auto', enabledStepIds: ['open-a'] }, [valveA, valveB])
  assert.equal(automatic.ok, true)
  assert.deepEqual(automatic.value, {
    mode: 'auto',
    sequence: [{ id: 'open-a', order: 1, componentId: 'valve-a', rpcMethod: 'setValveA', value: true, delayMs: 500 }],
    shutdown: false,
    steady: false,
  })
  assert.deepEqual(executeMockCommand(shifter, tag, 'manual', { mode: 'reset' }, { components: [valveA, valveB] }).value, {
    mode: 'reset', sequence: [], shutdown: true, steady: true,
  })
})

test('structured rules evaluate without arbitrary JavaScript', () => {
  assert.equal(evaluateRule(82, { operator: 'gte', value: 80 }), true)
  assert.equal(evaluateRule(7, { operator: 'between', min: 6, max: 8 }), true)
  assert.equal(evaluateRule('RUNNING', { operator: 'contains', value: 'RUN' }), true)
  assert.equal(evaluateRule(false, { operator: 'truthy' }), false)
})

test('value formatter preserves zero and applies transform and severity', () => {
  assert.equal(formatRuntimeValue(0, { decimals: 1, suffix: ' %' }), '0.0 %')
  assert.equal(formatRuntimeValue(5, { scale: 2, offset: 1, decimals: 0 }), '11')
  assert.equal(formatRuntimeValue(null, { fallback: '--' }), '--')
  assert.equal(valueSeverity(95, { warningHigh: 80, criticalHigh: 90 }), 'critical')
})

test('mock command enforces writable access and returns acknowledgment values', () => {
  const component = createComponentInstance('control-button', { id: 'button', canvas, tagId: 'valve', index: 0 })
  assert.equal(executeMockCommand(component, { access: 'read', dataType: 'boolean' }, false).ok, false)
  const result = executeMockCommand(component, { access: 'read-write', dataType: 'boolean' }, false)
  assert.equal(result.ok, true)
  assert.equal(result.value, true)
})

test('tuning slider accepts aligned numeric setpoints and rejects unsafe payloads', () => {
  const component = createComponentInstance('tuning-slider', { id: 'tuning', canvas, tagId: 'level', index: 0 })
  component.properties = { ...component.properties, min: 0, max: 100, step: 5 }
  const tag = { access: 'read-write', dataType: 'number' }
  assert.deepEqual(executeMockCommand(component, tag, 20, 55), { ok: true, message: 'Mock tuning command acknowledged.', value: 55 })
  assert.equal(executeMockCommand(component, tag, 20, 103).ok, false)
  assert.equal(executeMockCommand(component, tag, 20, 52).ok, false)
  assert.equal(executeMockCommand(component, { ...tag, dataType: 'boolean' }, 20, 55).ok, false)
})

test('tuning slider locks an operator draft and exposes a decisive apply state', () => {
  assert.deepEqual(
    tuningInteractionState({ dirty: false, editing: false, commandState: 'idle', fallbackLabel: 'IDLE' }),
    { syncFromLive: true, status: 'IDLE' },
  )
  assert.deepEqual(
    tuningInteractionState({ dirty: false, editing: true, commandState: 'idle', fallbackLabel: 'IDLE' }),
    { syncFromLive: false, status: 'EDITING' },
  )
  assert.deepEqual(
    tuningInteractionState({ dirty: true, editing: false, commandState: 'idle', fallbackLabel: 'IDLE' }),
    { syncFromLive: false, status: 'APPLY' },
  )
  assert.deepEqual(
    tuningInteractionState({ dirty: true, editing: false, commandState: 'pending', fallbackLabel: 'IDLE' }),
    { syncFromLive: false, status: 'SENDING' },
  )
})

test('restored versions expose immutable lineage and the next explicit version number', () => {
  const versions = [
    { id: 'v71-id', version: 71, restoredFromVersionId: 'v69-id', message: 'Rollback to version 69' },
    { id: 'v70-id', version: 70, message: 'Published revision 503' },
    { id: 'v69-id', version: 69, message: 'Published revision 502' },
  ]
  assert.equal(restoredFromVersionNumber(versions[0], versions), 69)
  assert.deepEqual(describeVersion(versions[0], versions), { kind: 'restore', restoredFrom: 69, label: 'Restored from v69' })
  assert.deepEqual(describeVersion(versions[1], versions), { kind: 'publish', restoredFrom: null, label: 'Published revision 503' })
  assert.equal(nextVersionNumber(versions), 72)
})

test('technical audit actions become compact human-readable labels', () => {
  assert.equal(auditActionLabel('command.accepted_by_gateway'), 'Command accepted by gateway')
  assert.equal(auditActionLabel('connector.rpc_test_succeeded'), 'Connector RPC test succeeded')
  assert.equal(auditActionCategory('project.rollback'), 'PROJECT')
  assert.equal(auditActionCategory(''), 'SYSTEM')
})

test('write-only commands do not depend on telemetry quality', () => {
  const writeOnly = { id: 'trigger', access: 'write', dataType: 'boolean' }
  const available = commandUiState({ tag: writeOnly, quality: 'disconnected', connectionAvailable: true })
  assert.equal(available.disabled, false)
  assert.equal(available.label, 'IDLE')
  assert.equal(available.requiresTelemetry, false)

  const streamOffline = commandUiState({ tag: writeOnly, quality: 'disconnected', connectionAvailable: false })
  assert.equal(streamOffline.disabled, true)
  assert.equal(streamOffline.label, 'DISCONNECTED')
})

test('read-write commands retain telemetry quality protection', () => {
  const readWrite = { id: 'level', access: 'read-write', dataType: 'number' }
  const stale = commandUiState({ tag: readWrite, quality: 'stale', connectionAvailable: true })
  assert.equal(stale.disabled, true)
  assert.equal(stale.label, 'STALE')
  assert.equal(stale.requiresTelemetry, true)
})

test('operation interlock disables supervised controls without reporting a disconnect', () => {
  const locked = commandUiState({ tag: { access: 'write', dataType: 'boolean' }, connectionAvailable: true, interlockLabel: 'AUTO LOCK' })
  assert.equal(locked.disabled, true)
  assert.equal(locked.label, 'AUTO LOCK')
  assert.equal(locked.interlocked, true)
})

test('publish validation catches incompatible and read-only control bindings', () => {
  const schema = {
    schemaVersion: '1.0.0',
    project: { id: 'p', name: 'P', slug: 'p', svgAssetId: 'a', canvas: { width: 1920, height: 1080, background: '#000' } },
    dataSources: [{ id: 'source_mock', type: 'mock' }],
    tags: [{ id: 'time', name: 'Time', path: 'time', dataType: 'datetime', access: 'read', sourceId: 'source_mock' }],
    components: [createComponentInstance('control-button', { id: 'button', canvas, tagId: 'time', index: 0 })],
  }
  const issues = validateProjectSchema(schema, { requireAsset: true })
  assert.ok(issues.some(issue => issue.code === 'binding.type'))
  assert.ok(issues.some(issue => issue.code === 'binding.readonly'))
})

test('publish validation checks tuning slider range and writable numeric binding', () => {
  const component = createComponentInstance('tuning-slider', { id: 'tuning', canvas, tagId: 'level', index: 0 })
  component.properties = { ...component.properties, min: 100, max: 10, step: 0, decimals: 9 }
  const schema = {
    schemaVersion: '1.1.0',
    project: { id: 'p', name: 'P', slug: 'p', svgAssetId: 'a', canvas: { ...canvas, background: '#000' } },
    dataSources: [{ id: 'source_mock', type: 'mock', environmentRef: 'development', connectorRef: null }],
    tags: [{ id: 'level', name: 'Level', path: 'level', dataType: 'number', access: 'read', sourceId: 'source_mock' }],
    components: [component],
  }
  const issues = validateProjectSchema(schema, { requireAsset: true })
  assert.ok(issues.some(issue => issue.code === 'binding.readonly'))
  assert.ok(issues.some(issue => issue.code === 'tuning.range'))
  assert.ok(issues.some(issue => issue.code === 'tuning.step'))
  assert.ok(issues.some(issue => issue.code === 'tuning.decimals'))
})
