import test from 'node:test'
import assert from 'node:assert/strict'
import { createComponentInstance } from '../shared/component-registry.js'
import { createNodeRedExport, serializeNodeRedExport } from '../shared/node-red-export.js'
import { applyNodeRedImportPlan, createNodeRedImportPlan, parseNodeRedFlow } from '../shared/node-red-import.js'
import { createProjectSchema, hasBlockingIssues, validateProjectSchema } from '../shared/project-schema.js'

function exportFixture() {
  const schema = createProjectSchema({ id: 'project-export', name: 'Water treatment export', slug: 'water-treatment-export' })
  schema.tags = [
    { id: 'tag_pressure', name: 'Tank pressure', path: 'tankPressure', dataType: 'number', access: 'read', sourceId: 'source_mock', freshnessMode: 'periodic', adaptiveFreshness: true, staleAfterMs: 10_000, metadata: { plcAddress: 'DB1.DBD0' } },
    { id: 'tag_pump', name: 'Pump enable', path: 'pumpEnable', dataType: 'boolean', access: 'write', sourceId: 'source_mock', freshnessMode: 'event-driven', adaptiveFreshness: false, staleAfterMs: 10_000, metadata: { plcAddress: 'DB1.DBX4.0' } },
    { id: 'tag_mode', name: 'Operation mode', path: 'operationMode', dataType: 'enum', access: 'read-write', sourceId: 'source_mock', freshnessMode: 'event-driven', adaptiveFreshness: true, staleAfterMs: 10_000, metadata: {} },
  ]
  const pressure = createComponentInstance('value-span', { id: 'cmp_pressure', canvas: schema.project.canvas, tagId: 'tag_pressure', index: 0 })
  pressure.name = 'Pressure value'
  pressure.properties = { ...pressure.properties, label: 'TANK PRESSURE', suffix: ' bar', decimals: 2 }
  const pump = createComponentInstance('control-button', { id: 'cmp_pump', canvas: schema.project.canvas, tagId: 'tag_pump', index: 1 })
  pump.name = 'Pump command'
  pump.properties = { ...pump.properties, label: 'PUMP ENABLE', rpcMethod: 'setPumpEnable' }
  const mode = createComponentInstance('operation-shifter', { id: 'cmp_mode', canvas: schema.project.canvas, tagId: 'tag_mode', index: 2 })
  mode.name = 'Operation mode'
  mode.properties = { ...mode.properties, label: 'OPERATION MODE', rpcMethod: 'setOperationMode' }
  const chart = createComponentInstance('chart', { id: 'cmp_chart', canvas: schema.project.canvas, tagId: 'tag_pressure', index: 3 })
  chart.name = 'Pressure history'
  const text = createComponentInstance('text-label', { id: 'cmp_text', canvas: schema.project.canvas, index: 4 })
  text.properties.text = 'PROCESS AREA'
  schema.components = [pressure, pump, mode, chart, text]
  return schema
}

test('Builder exporter creates deterministic native Node-RED nodes with safe placeholders', () => {
  const schema = exportFixture()
  const first = createNodeRedExport(schema)
  const second = createNodeRedExport(schema)
  const serialized = serializeNodeRedExport(first)

  assert.equal(first.fileName, 'water-treatment-export-node-red-flow.json')
  assert.equal(serialized, serializeNodeRedExport(second))
  assert.equal(first.stats.tags, 3)
  assert.equal(first.stats.plcMappedTags, 2)
  assert.equal(first.stats.dashboardNodes, 4)
  assert.equal(first.nodes.every(node => /^[a-f0-9]{16}$/.test(node.id)), true)
  assert.equal(new Set(first.nodes.map(node => node.id)).size, first.nodes.length)
  assert.equal(first.nodes.some(node => node.type === 'tab'), true)
  assert.equal(first.nodes.some(node => node.type === 'mqtt in'), true)
  assert.equal(first.nodes.some(node => node.type === 'mqtt out' && node.topic === 'v1/devices/me/telemetry'), true)
  assert.equal(first.nodes.some(node => node.type === 's7 in'), true)
  assert.equal(first.nodes.some(node => node.type === 'inject' && /template/i.test(node.name)), true)
  assert.deepEqual(first.nodes.find(node => node.type === 's7 endpoint').vartable, [
    { addr: 'DB1.DBD0', name: 'tankPressure' },
    { addr: 'DB1.DBX4.0', name: 'pumpEnable' },
  ])
  assert.equal(first.nodes.some(node => node.type === 'ui_gauge'), true)
  assert.equal(first.nodes.some(node => node.type === 'ui_button'), true)
  assert.equal(first.nodes.some(node => node.type === 'ui_dropdown'), true)
  assert.equal(first.nodes.some(node => node.type === 'ui_chart'), true)
  assert.match(first.nodes.find(node => node.name === 'Validate and route Builder RPC').func, /case "setPumpEnable"/)
})

test('exported flow round-trips exact tag semantics through validated embedded metadata', () => {
  const exported = createNodeRedExport(exportFixture())
  const analysis = parseNodeRedFlow(serializeNodeRedExport(exported))
  assert.equal(analysis.stats.embeddedScamaticTags, 3)

  const pressure = analysis.candidates.find(candidate => candidate.path === 'tankPressure')
  const pump = analysis.candidates.find(candidate => candidate.path === 'pumpEnable')
  const mode = analysis.candidates.find(candidate => candidate.path === 'operationMode')
  assert.deepEqual([pressure.dataType, pressure.access, pressure.componentType, pressure.componentProperties.suffix], ['number', 'read', 'value-span', ' bar'])
  assert.deepEqual([pump.dataType, pump.access, pump.componentType, pump.rpcMethod], ['boolean', 'write', 'control-button', 'setPumpEnable'])
  assert.deepEqual([mode.dataType, mode.access, mode.componentType, mode.rpcMethod], ['enum', 'read-write', 'operation-shifter', 'setOperationMode'])

  const target = createProjectSchema({ id: 'round-trip', name: 'Round trip', slug: 'round-trip' })
  const plan = createNodeRedImportPlan(analysis, target, { sourceId: 'source_mock' })
  const imported = applyNodeRedImportPlan(target, plan)
  assert.equal(plan.stats.tagsCreated, 3)
  assert.equal(plan.stats.componentsCreated, 3)
  assert.equal(imported.components.find(component => component.type === 'value-span').properties.suffix, ' bar')
  assert.equal(hasBlockingIssues(validateProjectSchema(imported)), false)
})

test('export excludes connector and component secrets instead of serializing project objects wholesale', () => {
  const schema = exportFixture()
  schema.dataSources[0].credentials = { username: 'admin', password: 'must-not-leak-password' }
  schema.dataSources[0].jwt = 'must-not-leak-jwt'
  schema.components[0].properties.deviceToken = 'must-not-leak-device-token'
  const exported = createNodeRedExport(schema)
  const serialized = serializeNodeRedExport(exported)
  assert.equal(serialized.includes('must-not-leak-password'), false)
  assert.equal(serialized.includes('must-not-leak-jwt'), false)
  assert.equal(serialized.includes('must-not-leak-device-token'), false)
  const broker = exported.nodes.find(node => node.type === 'mqtt-broker')
  assert.equal('credentials' in broker, false)
  assert.equal('username' in broker, false)
  assert.equal('password' in broker, false)
})

test('tags without PLC addresses use non-destructive template and TODO nodes', () => {
  const schema = createProjectSchema({ id: 'template-export', name: 'Template export', slug: 'template-export' })
  schema.tags = [
    { id: 'tag_read', name: 'Level', path: 'level', dataType: 'number', access: 'read', sourceId: 'source_mock' },
    { id: 'tag_write', name: 'Setpoint', path: 'setpoint', dataType: 'number', access: 'write', sourceId: 'source_mock' },
  ]
  const exported = createNodeRedExport(schema)
  assert.equal(exported.nodes.some(node => node.type === 'inject' && /template/i.test(node.name)), true)
  assert.equal(exported.nodes.some(node => node.type === 'debug' && /TODO connect write/.test(node.name)), true)
  assert.equal(exported.nodes.some(node => node.type === 's7 endpoint'), false)
  assert.equal(exported.warnings.some(warning => /no exported PLC address/.test(warning)), true)
})

test('duplicate command methods receive stable unique routes', () => {
  const schema = createProjectSchema({ id: 'rpc-routes', name: 'RPC routes', slug: 'rpc-routes' })
  schema.tags = [
    { id: 'tag_pump_a', name: 'Pump A', path: 'pump-a', dataType: 'boolean', access: 'write', sourceId: 'source_mock' },
    { id: 'tag_pump_b', name: 'Pump B', path: 'pump_a', dataType: 'boolean', access: 'write', sourceId: 'source_mock' },
  ]
  const exported = createNodeRedExport(schema)
  const analysis = parseNodeRedFlow(serializeNodeRedExport(exported))
  const methods = analysis.candidates.map(candidate => candidate.rpcMethod)
  assert.equal(new Set(methods).size, 2)
  assert.equal(exported.stats.adjustedRpcMethods, 1)
  assert.equal(exported.warnings.some(warning => /deterministic suffixes/.test(warning)), true)
})
