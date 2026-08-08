import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { applyNodeRedImportPlan, createNodeRedImportPlan, parseNodeRedFlow } from '../shared/node-red-import.js'
import { createProjectSchema, hasBlockingIssues, validateProjectSchema } from '../shared/project-schema.js'

const sampleFlow = JSON.parse(await readFile(new URL('../scada-alif.json', import.meta.url), 'utf8'))

test('Node-RED importer discovers telemetry, writable PLC variables, types, and RPC methods without executing functions', () => {
  const analysis = parseNodeRedFlow(sampleFlow)
  assert.equal(analysis.format, 'node-red')
  assert.equal(analysis.nodeCount, sampleFlow.length)
  assert.equal(analysis.stats.endpoints, 1)
  assert.equal(analysis.stats.telemetryKeys, 7)
  assert.equal(analysis.stats.writableVariables, 9)
  assert.equal(analysis.candidates.length, 14)

  const valve = analysis.candidates.find(candidate => candidate.path === 'Valve_106')
  assert.deepEqual({ dataType: valve.dataType, access: valve.access, componentType: valve.componentType }, { dataType: 'boolean', access: 'read', componentType: 'indicator-lamp' })
  const manualValve = analysis.candidates.find(candidate => candidate.path === 'M_ManualV106')
  assert.deepEqual({ dataType: manualValve.dataType, access: manualValve.access, rpcMethod: manualValve.rpcMethod, componentType: manualValve.componentType }, { dataType: 'boolean', access: 'write', rpcMethod: 'setM_ManualV106', componentType: 'control-button' })
  const level = analysis.candidates.find(candidate => candidate.path === 'Level_Air')
  assert.deepEqual({ dataType: level.dataType, access: level.access, rpcMethod: level.rpcMethod, componentType: level.componentType }, { dataType: 'number', access: 'read-write', rpcMethod: 'setLevel_Air', componentType: 'tuning-slider' })
})

test('Node-RED import plan creates valid tags and suggested components for an existing source', () => {
  const schema = createProjectSchema({ id: 'project-import', name: 'Imported plant', slug: 'imported-plant' })
  const analysis = parseNodeRedFlow(sampleFlow)
  const plan = createNodeRedImportPlan(analysis, schema, { sourceId: 'source_mock' })
  const imported = applyNodeRedImportPlan(schema, plan)

  assert.equal(plan.stats.tagsCreated, 14)
  assert.equal(plan.stats.componentsCreated, 14)
  assert.equal(imported.tags.every(tag => tag.metadata.importSource === 'node-red'), true)
  assert.equal(imported.components.every(component => component.metadata.importSource === 'node-red'), true)
  assert.equal(hasBlockingIssues(validateProjectSchema(imported)), false)
})

test('Node-RED re-import reuses existing tags and components instead of duplicating them', () => {
  const schema = createProjectSchema({ id: 'project-reimport', name: 'Reimport', slug: 'reimport' })
  const analysis = parseNodeRedFlow(sampleFlow)
  const firstPlan = createNodeRedImportPlan(analysis, schema, { sourceId: 'source_mock' })
  const imported = applyNodeRedImportPlan(schema, firstPlan)
  const secondPlan = createNodeRedImportPlan(analysis, imported, { sourceId: 'source_mock' })

  assert.equal(secondPlan.tags.length, 0)
  assert.equal(secondPlan.components.length, 0)
  assert.equal(secondPlan.stats.tagsReused, 14)
  assert.equal(secondPlan.stats.componentsReused, 14)
})

test('Node-RED import selection can create tags without every suggested component', () => {
  const schema = createProjectSchema({ id: 'project-select', name: 'Selected import', slug: 'selected-import' })
  const analysis = parseNodeRedFlow(sampleFlow)
  const selected = analysis.candidates.filter(candidate => ['Valve_106', 'Level_Air'].includes(candidate.path))
  const plan = createNodeRedImportPlan(analysis, schema, {
    sourceId: 'source_mock',
    selectedKeys: selected.map(candidate => candidate.importKey),
    componentKeys: [selected.find(candidate => candidate.path === 'Valve_106').importKey],
  })
  assert.deepEqual(plan.tags.map(tag => tag.path).sort(), ['Level_Air', 'Valve_106'])
  assert.deepEqual(plan.components.map(component => component.type), ['indicator-lamp'])
})

test('Node-RED Dashboard nodes provide a safe fallback when no PLC endpoint exists', () => {
  const analysis = parseNodeRedFlow([
    { id: 'tab', type: 'tab', label: 'Dashboard' },
    { id: 'gauge', type: 'ui_gauge', label: 'Tank pressure', topic: 'tankPressure' },
    { id: 'switch', type: 'ui_switch', label: 'Pump enable', topic: 'pumpEnable' },
  ])
  assert.deepEqual(analysis.candidates.map(candidate => [candidate.path, candidate.dataType, candidate.access, candidate.componentType]), [
    ['pumpEnable', 'boolean', 'read-write', 'control-button'],
    ['tankPressure', 'number', 'read', 'value-span'],
  ])
})

test('Node-RED importer rejects unsafe shapes and never carries flow credentials into the draft', () => {
  assert.throws(() => parseNodeRedFlow('{}'), /array of flow nodes/)
  assert.throws(() => parseNodeRedFlow('not-json'), /not valid JSON/)
  const flow = [
    { id: 'tab', type: 'tab', label: 'Credential test' },
    { id: 'broker', type: 'mqtt-broker', broker: 'example.test', credentials: { user: 'admin', password: 'must-not-leak' } },
    { id: 'gauge', type: 'ui_gauge', label: 'Pressure', topic: 'pressure', broker: 'broker', token: 'must-not-leak' },
  ]
  const schema = createProjectSchema({ id: 'safe', name: 'Safe import', slug: 'safe-import' })
  const analysis = parseNodeRedFlow(flow)
  const plan = createNodeRedImportPlan(analysis, schema, { sourceId: 'source_mock' })
  const serialized = JSON.stringify(applyNodeRedImportPlan(schema, plan))
  assert.equal(serialized.includes('must-not-leak'), false)
  assert.equal(serialized.includes('example.test'), false)
})
