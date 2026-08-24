import test from 'node:test'
import assert from 'node:assert/strict'
import { createComponentInstance } from '../shared/component-registry.js'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'

function commandSchema() {
  const schema = createProjectSchema({ id: 'command-validation', name: 'Command validation', slug: 'command-validation' })
  schema.tags.push(
    { id: 'pump.command', name: 'Pump command', path: 'pump_command', dataType: 'boolean', access: 'write', sourceId: 'source_mock' },
    { id: 'pump.feedback', name: 'Pump feedback', path: 'pump_feedback', dataType: 'string', access: 'read', sourceId: 'source_mock' },
    { id: 'speed.command', name: 'Speed command', path: 'speed_command', dataType: 'number', access: 'read-write', sourceId: 'source_mock', engineering: { min: 0, max: 100, unit: '%', decimals: 1 }, writeConstraints: { min: 0, max: 100, step: 1 } },
  )
  return schema
}

test('command validation catches feedback type mismatches and ambiguous duplicate RPC methods', () => {
  const schema = commandSchema()
  const first = createComponentInstance('control-button', { id: 'pump-start', canvas: schema.project.canvas, tagId: 'pump.command', index: 0 })
  const second = createComponentInstance('control-button', { id: 'pump-stop', canvas: schema.project.canvas, tagId: 'pump.command', index: 1 })
  first.properties = { ...first.properties, rpcMethod: 'setPump', feedbackTagId: 'pump.feedback' }
  second.properties = { ...second.properties, rpcMethod: 'setPump' }
  schema.components.push(first, second)

  const issues = validateProjectSchema(schema)
  const feedbackIssue = issues.find(issue => issue.code === 'command.feedback.type')
  const duplicateIssue = issues.find(issue => issue.code === 'command.rpcMethod.duplicate')

  assert.equal(feedbackIssue.path, 'components.0.properties.feedbackTagId')
  assert.equal(duplicateIssue.path, 'components.1.properties.rpcMethod')
  assert.deepEqual(duplicateIssue.relatedPaths, ['components.0.properties.rpcMethod'])
})

test('control validation rejects actions that are incompatible with the command Tag', () => {
  const schema = commandSchema()
  const button = createComponentInstance('control-button', { id: 'speed-pulse', canvas: schema.project.canvas, tagId: 'speed.command', index: 0 })
  button.properties = { ...button.properties, action: 'pulse', pulseMs: 10 }
  schema.components.push(button)

  const codes = new Set(validateProjectSchema(schema).map(issue => issue.code))
  assert.equal(codes.has('button.action.type'), true)
  assert.equal(codes.has('button.pulse'), true)
})

test('rule and Value Span validation catches reversed numeric ranges and thresholds', () => {
  const schema = commandSchema()
  const lamp = createComponentInstance('indicator-lamp', { id: 'speed-alarm', canvas: schema.project.canvas, tagId: 'speed.command', index: 0 })
  lamp.properties = { ...lamp.properties, rule: { operator: 'between', min: 80, max: 20 } }
  const value = createComponentInstance('value-span', { id: 'speed-value', canvas: schema.project.canvas, tagId: 'speed.command', index: 1 })
  value.properties = { ...value.properties, warningHigh: 80, criticalHigh: 70, warningLow: 20, criticalLow: 30 }
  schema.components.push(lamp, value)

  const codes = new Set(validateProjectSchema(schema).map(issue => issue.code))
  assert.equal(codes.has('rule.range'), true)
  assert.equal(codes.has('value.thresholds.high'), true)
  assert.equal(codes.has('value.thresholds.low'), true)
})

test('duplicate entity diagnostics point back to the first conflicting schema path', () => {
  const schema = commandSchema()
  schema.tags.push({ ...schema.tags[0], id: 'duplicate-id', path: 'pump_command' })
  const issue = validateProjectSchema(schema).find(item => item.code === 'tag.path' && item.path === 'tags.3.path')

  assert.deepEqual(issue.relatedPaths, ['tags.0.path'])
})

test('secret validation reports the exact path while marking the value as redacted', () => {
  const schema = commandSchema()
  schema.dataSources[0].config = { nested: { accessKey: 'do-not-expose' } }
  const issue = validateProjectSchema(schema).find(item => item.code === 'schema.secret')

  assert.equal(issue.path, 'dataSources.0.config.nested.accessKey')
  assert.equal(issue.redacted, true)
})
