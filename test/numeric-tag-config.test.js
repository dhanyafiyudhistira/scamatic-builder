import test from 'node:test'
import assert from 'node:assert/strict'
import { createComponentInstance } from '../shared/component-registry.js'
import { numericDisplayProperties, numericDisplayUnit, numericEngineering, numericFormatMode, numericValueOutOfRange, resolveNumericRange } from '../shared/numeric-tag-config.js'
import { executeMockCommand } from '../shared/runtime-evaluator.js'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'

const tag = {
  id: 'temperature',
  dataType: 'number',
  access: 'read-write',
  engineering: { min: -50, max: 150, unit: ' °C', decimals: 1 },
  writeConstraints: { min: 0, max: 100, step: 5 },
}

test('Gauge and Slider inherit the canonical Tag ranges for their distinct purposes', () => {
  assert.deepEqual(resolveNumericRange(tag, { rangeMode: 'inherit', min: 0, max: 10 }, 'display'), {
    min: -50,
    max: 150,
    unit: ' °C',
    decimals: 1,
    mode: 'inherit',
    source: 'tag',
  })
  assert.deepEqual(resolveNumericRange(tag, { rangeMode: 'inherit', min: -100, max: 200, step: 1 }, 'write'), {
    min: 0,
    max: 100,
    step: 5,
    mode: 'inherit',
    source: 'tag',
  })
  assert.deepEqual(resolveNumericRange(tag, { rangeMode: 'custom', min: 20, max: 80, step: 10 }, 'write'), {
    min: 20,
    max: 80,
    step: 10,
    mode: 'custom',
    source: 'component-narrowed',
  })
})

test('Slider command validation uses Tag limits even when component defaults disagree', () => {
  const component = createComponentInstance('tuning-slider', { id: 'slider', canvas: { width: 800, height: 600 }, tagId: tag.id, index: 0 })
  assert.equal(executeMockCommand(component, tag, 50, -5).ok, false)
  assert.equal(executeMockCommand(component, tag, 50, 12).ok, false)
  assert.equal(executeMockCommand(component, tag, 50, 15).ok, true)
})

test('Value Span inherits engineering formatting and reports transformed out-of-range values without clamping', () => {
  assert.equal(numericDisplayProperties(tag, { suffix: '', decimals: null }).suffix, ' °C')
  assert.equal(numericValueOutOfRange(tag, 60, { scale: 2, offset: 40 }), true)
  assert.equal(numericValueOutOfRange(tag, 40, { scale: 2, offset: 0 }), false)
})

test('Gauge units inherit from the bound Tag unless a custom unit is explicit', () => {
  assert.equal(numericDisplayUnit(tag, { suffix: '%' }), ' °C')
  assert.equal(numericDisplayUnit(tag, { unitMode: 'inherit', suffix: '%' }), ' °C')
  assert.equal(numericDisplayUnit(tag, { unitMode: 'custom', suffix: ' pH' }), ' pH')
})

test('numeric Tags distinguish normal numbers from percentages without component suffix defaults', () => {
  const percentage = { dataType: 'number', numberFormat: 'percentage', engineering: { min: 0, max: 100, unit: '', decimals: 1 } }
  const legacyPercentage = { dataType: 'number', engineering: { min: 0, max: 100, unit: '%', decimals: 0 } }
  assert.equal(numericFormatMode(percentage), 'percentage')
  assert.equal(numericEngineering(percentage).unit, '%')
  assert.equal(numericDisplayProperties(percentage, { suffix: '' }).suffix, '%')
  assert.equal(numericFormatMode(legacyPercentage), 'percentage')
  assert.equal(createComponentInstance('gauge', { id: 'gauge-format', canvas: { width: 800, height: 600 } }).properties.suffix, '')
  assert.equal(createComponentInstance('gauge', { id: 'gauge-unit', canvas: { width: 800, height: 600 } }).properties.unitMode, 'inherit')
  assert.equal(createComponentInstance('tuning-slider', { id: 'slider-format', canvas: { width: 800, height: 600 } }).properties.suffix, '')
})

test('numeric Tag validation keeps number format and engineering unit consistent', () => {
  const schema = createProjectSchema({ id: 'numeric-format', name: 'Numeric format', slug: 'numeric-format' })
  schema.tags = [{
    id: 'level', name: 'Level', path: 'level', dataType: 'number', access: 'read', sourceId: 'source_mock',
    freshnessMode: 'periodic', adaptiveFreshness: true, staleAfterMs: 10_000,
    numberFormat: 'percentage', engineering: { min: 0, max: 100, unit: 'bar', decimals: 1 },
  }]
  let codes = new Set(validateProjectSchema(schema).map(issue => issue.code))
  assert.equal(codes.has('tag.numberFormat.unit'), true)
  schema.tags[0].engineering.unit = '%'
  codes = new Set(validateProjectSchema(schema).map(issue => issue.code))
  assert.equal(codes.has('tag.numberFormat.unit'), false)
})
