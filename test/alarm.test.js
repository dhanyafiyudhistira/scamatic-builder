import test from 'node:test'
import assert from 'node:assert/strict'
import { createComponentInstance } from '../shared/component-registry.js'
import { evaluateAlarmState, normalizeAlarmProperties } from '../shared/alarm.js'
import { createNodeRedExport, serializeNodeRedExport } from '../shared/node-red-export.js'
import { applyNodeRedImportPlan, createNodeRedImportPlan, parseNodeRedFlow } from '../shared/node-red-import.js'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'

const canvas = { width: 1920, height: 1080 }

test('Alarm defaults to a tag-driven lamp and evaluates only good-quality telemetry', () => {
  const component = createComponentInstance('alarm', { id: 'alarm-main', canvas, tagId: 'trip', index: 0 })
  assert.equal(component.properties.presentation, 'lamp')
  assert.deepEqual(component.position.width, 180)
  assert.equal(evaluateAlarmState({ tag: { id: 'trip' }, value: true, quality: 'good', properties: component.properties }).active, true)
  assert.deepEqual(
    evaluateAlarmState({ tag: { id: 'trip' }, value: true, quality: 'bad', properties: component.properties }),
    { ...normalizeAlarmProperties(component.properties), active: false, ruleSource: 'component', stateLabel: 'BAD' },
  )
})

test('Alarm supports Buzzer presentation and structured trigger rules', () => {
  const properties = {
    presentation: 'buzzer',
    frequencyHz: 1200,
    volume: 0.24,
    pulseMs: 400,
    rule: { operator: 'gte', value: 80 },
  }
  assert.deepEqual(normalizeAlarmProperties(properties), {
    presentation: 'buzzer',
    activeColor: '#ef4444',
    idleColor: '#46545d',
    flash: true,
    soundEnabled: true,
    frequencyHz: 1200,
    volume: 0.24,
    pulseMs: 400,
  })
  assert.equal(evaluateAlarmState({ tag: { id: 'temperature' }, value: 79, properties }).active, false)
  assert.equal(evaluateAlarmState({ tag: { id: 'temperature' }, value: 80, properties }).active, true)
})

test('numeric Alarm inherits its reaction threshold from the bound Tag and permits a component override', () => {
  const component = createComponentInstance('alarm', { id: 'alarm-temperature', canvas, tagId: 'temperature', index: 0 })
  const tag = {
    id: 'temperature',
    dataType: 'number',
    engineering: { min: 0, max: 120, unit: '%', decimals: 1 },
    alarmRule: { operator: 'gte', value: 90 },
  }
  assert.deepEqual(
    evaluateAlarmState({ tag, value: 89, properties: component.properties }),
    { ...normalizeAlarmProperties(component.properties), active: false, ruleSource: 'tag', stateLabel: 'NORMAL' },
  )
  assert.equal(evaluateAlarmState({ tag, value: 90, properties: component.properties }).active, true)
  const custom = { ...component.properties, ruleMode: 'custom', rule: { operator: 'outside', min: 20, max: 100 } }
  assert.equal(evaluateAlarmState({ tag, value: 10, properties: custom }).active, true)
  assert.equal(evaluateAlarmState({ tag, value: 50, properties: custom }).active, false)
})

test('project validation reports invalid Alarm presentation and sound settings precisely', () => {
  const schema = alarmFixture()
  schema.components[0].properties = {
    ...schema.components[0].properties,
    presentation: 'siren',
    frequencyHz: 5000,
    volume: 0.8,
    pulseMs: 20.5,
    activeColor: 'red',
  }
  const codes = new Set(validateProjectSchema(schema).map(issue => issue.code))
  assert.equal(codes.has('alarm.presentation'), true)
  assert.equal(codes.has('alarm.frequency'), true)
  assert.equal(codes.has('alarm.volume'), true)
  assert.equal(codes.has('alarm.pulse'), true)
  assert.equal(codes.has('alarm.color'), true)
})

test('project validation keeps numeric Tag Alarm thresholds inside engineering limits', () => {
  const schema = alarmFixture()
  schema.tags[0].alarmRule = { operator: 'outside', min: -1, max: 90 }
  let codes = new Set(validateProjectSchema(schema).map(issue => issue.code))
  assert.equal(codes.has('tag.alarmRule.bounds'), true)
  schema.tags[0].alarmRule = { operator: 'outside', min: 100, max: 90 }
  codes = new Set(validateProjectSchema(schema).map(issue => issue.code))
  assert.equal(codes.has('tag.alarmRule.range'), true)
})

test('Alarm configuration round-trips through safe Node-RED metadata', () => {
  const schema = alarmFixture()
  schema.components[0].properties = {
    ...schema.components[0].properties,
    presentation: 'buzzer',
    ruleMode: 'custom',
    rule: { operator: 'outside', min: 10, max: 100 },
    activeColor: '#ff3344',
    idleColor: '#334455',
    frequencyHz: 1320,
    volume: 0.22,
    pulseMs: 480,
  }
  const analysis = parseNodeRedFlow(serializeNodeRedExport(createNodeRedExport(schema)))
  const candidate = analysis.candidates.find(item => item.path === 'highTemperatureAlarm')
  assert.equal(candidate.componentType, 'alarm')
  assert.equal(candidate.numberFormat, 'percentage')
  assert.deepEqual(candidate.alarmRule, { operator: 'gte', value: 90 })
  assert.deepEqual(candidate.componentProperties, {
    label: 'PROCESS ALARM',
    presentation: 'buzzer',
    ruleMode: 'custom',
    rule: { operator: 'outside', min: 10, max: 100 },
    activeColor: '#ff3344',
    idleColor: '#334455',
    flash: true,
    soundEnabled: true,
    frequencyHz: 1320,
    volume: 0.22,
    pulseMs: 480,
  })
  const target = createProjectSchema({ id: 'alarm-import', name: 'Alarm import', slug: 'alarm-import' })
  const imported = applyNodeRedImportPlan(target, createNodeRedImportPlan(analysis, target, { sourceId: 'source_mock' }))
  const alarm = imported.components.find(component => component.type === 'alarm')
  const importedTag = imported.tags.find(tag => tag.path === 'highTemperatureAlarm')
  assert.equal(importedTag.numberFormat, 'percentage')
  assert.deepEqual(importedTag.alarmRule, { operator: 'gte', value: 90 })
  assert.equal(alarm.properties.presentation, 'buzzer')
  assert.equal(alarm.properties.ruleMode, 'custom')
  assert.deepEqual(alarm.properties.rule, { operator: 'outside', min: 10, max: 100 })
  assert.equal(alarm.properties.frequencyHz, 1320)
})

function alarmFixture() {
  const schema = createProjectSchema({ id: 'alarm-project', name: 'Alarm project', slug: 'alarm-project' })
  schema.tags = [{
    id: 'tag_alarm',
    name: 'High temperature alarm',
    path: 'highTemperatureAlarm',
    dataType: 'number',
    access: 'read',
    sourceId: 'source_mock',
    freshnessMode: 'periodic',
    adaptiveFreshness: true,
    staleAfterMs: 10_000,
    engineering: { min: 0, max: 120, unit: '°C', decimals: 1 },
    numberFormat: 'percentage',
    alarmRule: { operator: 'gte', value: 90 },
  }]
  schema.components = [createComponentInstance('alarm', { id: 'cmp_alarm', canvas: schema.project.canvas, tagId: 'tag_alarm', index: 0 })]
  return schema
}
