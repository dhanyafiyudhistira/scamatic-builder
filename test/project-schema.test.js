import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectSchema, hasBlockingIssues, migrateProjectSchema, PROJECT_SCHEMA_VERSION, validateProjectSchema } from '../shared/project-schema.js'
import { publishedEnvironmentRef } from '../api/_handlers/publish.js'

function validSchema() {
  const schema = createProjectSchema({ id: 'project-1', name: 'Mixer', slug: 'mixer' })
  schema.project.svgAssetId = 'asset-1'
  schema.tags.push({ id: 'motor.running', name: 'Motor Running', path: 'motor_running', dataType: 'boolean', access: 'read', sourceId: 'source_mock' })
  schema.components.push({
    id: 'lamp-1',
    type: 'indicator-lamp',
    name: 'Motor Lamp',
    position: { x: 10, y: 10, width: 80, height: 80, rotation: 0 },
    binding: { tagId: 'motor.running' },
    properties: { label: 'MOTOR' },
  })
  return schema
}

test('valid project schema passes publish validation', () => {
  const issues = validateProjectSchema(validSchema(), { requireAsset: true })
  assert.equal(hasBlockingIssues(issues), false)
})

test('published version records the live connector environment instead of mock', () => {
  const schema = createProjectSchema({ id: 'project-env', name: 'Environment', slug: 'environment' })
  assert.equal(publishedEnvironmentRef(schema), 'mock')
  schema.dataSources.push({ id: 'source_tb', type: 'thingsboard', environmentRef: 'staging', connectorRef: 'connector-1' })
  assert.equal(publishedEnvironmentRef(schema), 'staging')
})

test('broken binding and duplicate component id block publish', () => {
  const schema = validSchema()
  schema.components.push({ ...schema.components[0], binding: { tagId: 'missing.tag' } })
  const issues = validateProjectSchema(schema, { requireAsset: true })
  assert.equal(hasBlockingIssues(issues), true)
  assert.ok(issues.some(issue => issue.code === 'component.id'))
  assert.ok(issues.some(issue => issue.code === 'binding.broken'))
})

test('secret-like values are rejected from client schema', () => {
  const schema = validSchema()
  schema.dataSources[0].token = 'must-not-be-client-side'
  const issues = validateProjectSchema(schema)
  assert.ok(issues.some(issue => issue.code === 'schema.secret'))
})

test('static text components publish without a tag binding', () => {
  const schema = validSchema()
  schema.components.push({
    id: 'text-1',
    type: 'text-label',
    name: 'Area heading',
    position: { x: 120, y: 40, width: 280, height: 72, rotation: 0 },
    binding: { tagId: null },
    properties: { text: 'MIXING AREA', textColor: '#17232c', fontSize: 32, textAlign: 'left' },
  })
  const issues = validateProjectSchema(schema, { requireAsset: true })
  assert.equal(issues.some(issue => issue.path === 'components.1.binding'), false)
  assert.equal(hasBlockingIssues(issues), false)
})

test('legacy 1.0.0 mock projects migrate without losing bindings', () => {
  const legacy = validSchema()
  legacy.schemaVersion = '1.0.0'
  delete legacy.dataSources[0].connectorRef
  delete legacy.tags[0].staleAfterMs
  const migrated = migrateProjectSchema(legacy)
  assert.equal(migrated.schemaVersion, PROJECT_SCHEMA_VERSION)
  assert.equal(migrated.project.runtimeProfile, 'simulation')
  assert.equal(migrated.dataSources[0].connectorRef, null)
  assert.equal(migrated.tags[0].sourceId, 'source_mock')
  assert.equal(migrated.tags[0].staleAfterMs, 10_000)
  assert.equal(migrated.tags[0].freshnessMode, 'periodic')
  assert.equal(migrated.tags[0].adaptiveFreshness, true)
  assert.equal(hasBlockingIssues(validateProjectSchema(migrated)), false)
})

test('legacy 1.1.0 projects migrate to the Control Pop-up schema without changing components', () => {
  const legacy = validSchema()
  legacy.schemaVersion = '1.1.0'
  const migrated = migrateProjectSchema(legacy)
  assert.equal(migrated.schemaVersion, PROJECT_SCHEMA_VERSION)
  assert.deepEqual(migrated.components, legacy.components)
})

test('legacy 1.2.0 tags migrate to bounded adaptive freshness', () => {
  const legacy = validSchema()
  legacy.schemaVersion = '1.2.0'
  legacy.tags[0].staleAfterMs = 15_000
  const migrated = migrateProjectSchema(legacy)
  assert.equal(migrated.schemaVersion, PROJECT_SCHEMA_VERSION)
  assert.equal(migrated.tags[0].freshnessMode, 'periodic')
  assert.equal(migrated.tags[0].adaptiveFreshness, true)
  assert.equal(migrated.tags[0].staleAfterMs, 15_000)
})

test('legacy tuning sliders migrate the former fast default to 0.1 percent of range per second', () => {
  const legacy = validSchema()
  legacy.schemaVersion = '1.4.0'
  legacy.components.push({
    id: 'slider-legacy',
    type: 'tuning-slider',
    name: 'Level setpoint',
    position: { x: 100, y: 100, width: 320, height: 132, rotation: 0 },
    binding: { tagId: null },
    properties: { min: 0, max: 100, simulationRampPerSecond: 5 },
  })
  const migrated = migrateProjectSchema(legacy)
  assert.equal(migrated.schemaVersion, PROJECT_SCHEMA_VERSION)
  assert.equal(migrated.components.at(-1).properties.simulationRampPerSecond, 0.1)
})

test('Operation Shifter legacy panel geometry migrates to the compact dropdown trigger', () => {
  const schema = validSchema()
  schema.components.push({
    id: 'mode-shifter',
    type: 'operation-shifter',
    name: 'Operation mode',
    position: { x: 320, y: 100, width: 420, height: 210, rotation: 0 },
    binding: { tagId: null },
    properties: { label: 'OPERATION MODE', autoSequence: [], controlledComponentIds: [] },
  })
  const migrated = migrateProjectSchema(schema)
  assert.equal(migrated.components.at(-1).position.width, 220)
  assert.equal(migrated.components.at(-1).position.height, 72)
  assert.equal(schema.components.at(-1).position.width, 420)
})

test('tag freshness configuration rejects unsafe modes and thresholds', () => {
  const schema = validSchema()
  Object.assign(schema.tags[0], { freshnessMode: 'guess', adaptiveFreshness: 'yes', staleAfterMs: 100 })
  const issues = validateProjectSchema(schema)
  assert.ok(issues.some(issue => issue.code === 'tag.freshnessMode'))
  assert.ok(issues.some(issue => issue.code === 'tag.adaptiveFreshness'))
  assert.ok(issues.some(issue => issue.code === 'tag.staleAfter'))
})

test('Operation Shifter validates supervised controls and AUTO sequence references', () => {
  const schema = validSchema()
  schema.tags.push(
    { id: 'mode.command', name: 'Mode command', path: 'mode_command', dataType: 'enum', access: 'write', sourceId: 'source_mock' },
    { id: 'valve.command', name: 'Valve command', path: 'valve_command', dataType: 'boolean', access: 'write', sourceId: 'source_mock' },
  )
  schema.components.push(
    { id: 'valve-button', type: 'control-button', name: 'Valve', position: { x: 100, y: 100, width: 180, height: 72, rotation: 0 }, binding: { tagId: 'valve.command' }, properties: { rpcMethod: 'setValve', action: 'toggle-boolean' } },
    { id: 'mode-shifter', type: 'operation-shifter', name: 'Mode', position: { x: 320, y: 100, width: 420, height: 210, rotation: 0 }, binding: { tagId: 'mode.command' }, properties: { rpcMethod: 'setOperationMode', controlledComponentIds: ['valve-button'], autoSequence: [{ id: 'step-1', componentId: 'valve-button', value: true, delayMs: 500, enabled: true }] } },
  )
  assert.equal(hasBlockingIssues(validateProjectSchema(schema)), false)
  schema.components.at(-1).properties.autoSequence[0].componentId = 'missing'
  const issues = validateProjectSchema(schema)
  assert.ok(issues.some(issue => issue.code === 'operation.stepControl'))
})

test('Control Pop-up accepts unique Button and Slider references without tag binding', () => {
  const schema = validSchema()
  schema.tags.push(
    { id: 'command', name: 'Command', path: 'command', dataType: 'boolean', access: 'write', sourceId: 'source_mock' },
    { id: 'setpoint', name: 'Setpoint', path: 'setpoint', dataType: 'number', access: 'read-write', sourceId: 'source_mock' },
  )
  schema.components.push(
    { id: 'button-1', type: 'control-button', name: 'Auto', position: { x: 120, y: 120, width: 180, height: 72, rotation: 0 }, binding: { tagId: 'command' }, properties: { label: 'AUTO', ackTimeoutMs: 5000 } },
    { id: 'slider-1', type: 'tuning-slider', name: 'Level', position: { x: 120, y: 220, width: 320, height: 132, rotation: 0 }, binding: { tagId: 'setpoint' }, properties: { label: 'LEVEL', min: 0, max: 100, step: 1, decimals: 0, ackTimeoutMs: 5000 } },
    { id: 'popup-1', type: 'control-popup', name: 'Controls', position: { x: 500, y: 100, width: 220, height: 72, rotation: 0 }, binding: { tagId: null }, children: ['button-1', 'slider-1'], properties: { label: 'CONTROLS', triggerLabel: 'OPEN', columns: 2, dialogWidth: 720 } },
  )
  const issues = validateProjectSchema(schema)
  assert.equal(issues.some(issue => issue.code.startsWith('popup.')), false)
  assert.equal(issues.some(issue => issue.path === 'components.3.binding'), false)
})

test('Control Pop-up blocks invalid, duplicate, and multiply-owned children', () => {
  const schema = validSchema()
  schema.components.push(
    { id: 'popup-1', type: 'control-popup', name: 'Controls A', position: { x: 500, y: 100, width: 220, height: 72, rotation: 0 }, children: ['lamp-1', 'missing', 'lamp-1'], properties: { columns: 4, dialogWidth: 200 } },
    { id: 'popup-2', type: 'control-popup', name: 'Controls B', position: { x: 500, y: 200, width: 220, height: 72, rotation: 0 }, children: ['lamp-1'], properties: { columns: 2, dialogWidth: 720 } },
  )
  const issues = validateProjectSchema(schema)
  assert.ok(issues.some(issue => issue.code === 'popup.child.type'))
  assert.ok(issues.some(issue => issue.code === 'popup.child.missing'))
  assert.ok(issues.some(issue => issue.code === 'popup.children.duplicate'))
  assert.ok(issues.some(issue => issue.code === 'popup.child.owner'))
  assert.ok(issues.some(issue => issue.code === 'popup.columns'))
  assert.ok(issues.some(issue => issue.code === 'popup.width'))
})

test('thingsboard source requires connector reference and valid tag mapping', () => {
  const schema = validSchema()
  schema.dataSources.push({ id: 'source_tb', type: 'thingsboard', environmentRef: 'staging', connectorRef: null })
  schema.tags.push({ id: 'level', name: 'Level', path: 'Level_mix', dataType: 'number', access: 'read', sourceId: 'source_tb', staleAfterMs: 10_000 })
  const issues = validateProjectSchema(schema)
  assert.ok(issues.some(issue => issue.code === 'source.connector'))
})

test('chart accepts unique readable numeric telemetry bindings', () => {
  const schema = validSchema()
  schema.tags.push(
    { id: 'level', name: 'Level', path: 'level', dataType: 'number', access: 'read', sourceId: 'source_mock' },
    { id: 'setpoint', name: 'Setpoint', path: 'setpoint', dataType: 'number', access: 'read-write', sourceId: 'source_mock' },
  )
  schema.components.push({
    id: 'chart-1',
    type: 'chart',
    name: 'Process chart',
    position: { x: 120, y: 120, width: 180, height: 64, rotation: 0 },
    binding: { tagId: null, tagIds: ['level', 'setpoint'] },
    properties: { label: 'PROCESS', historyLimit: 300, windowMinutes: 60, showLegend: true, accentColor: '#20c4d9' },
  })
  const issues = validateProjectSchema(schema, { requireAsset: true })
  assert.equal(issues.some(issue => issue.path.startsWith('components.1.binding')), false)
  assert.equal(hasBlockingIssues(issues), false)
})

test('chart rejects incompatible, write-only, duplicate, and unsafe history settings', () => {
  const schema = validSchema()
  schema.tags.push(
    { id: 'text', name: 'Text', path: 'text', dataType: 'string', access: 'read', sourceId: 'source_mock' },
    { id: 'output', name: 'Output', path: 'output', dataType: 'number', access: 'write', sourceId: 'source_mock' },
  )
  schema.components.push({
    id: 'chart-1',
    type: 'chart',
    name: 'Broken chart',
    position: { x: 120, y: 120, width: 180, height: 64, rotation: 0 },
    binding: { tagId: null, tagIds: ['text', 'output', 'output'] },
    properties: { label: 'PROCESS', historyLimit: 5, windowMinutes: 2000 },
  })
  const issues = validateProjectSchema(schema)
  assert.ok(issues.some(issue => issue.code === 'binding.type'))
  assert.ok(issues.some(issue => issue.code === 'chart.tags.writeonly'))
  assert.ok(issues.some(issue => issue.code === 'chart.tags.duplicate'))
  assert.ok(issues.some(issue => issue.code === 'chart.historyLimit'))
  assert.ok(issues.some(issue => issue.code === 'chart.windowMinutes'))
})
