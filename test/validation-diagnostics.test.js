import test from 'node:test'
import assert from 'node:assert/strict'
import { createComponentInstance } from '../shared/component-registry.js'
import { createProjectSchema } from '../shared/project-schema.js'
import { validationConsoleReport, validationDiagnostics, validationSummary } from '../shared/validation-diagnostics.js'

function diagnosticSchema() {
  const schema = createProjectSchema({ id: 'diagnostics', name: 'Diagnostics', slug: 'diagnostics' })
  schema.tags.push({ id: 'temperature', name: 'Temperature', path: 'temperature', dataType: 'number', access: 'read', sourceId: 'source_mock', engineering: { min: 0, max: 100, unit: '°C', decimals: 1 } })
  const gauge = createComponentInstance('gauge', { id: 'gauge-temperature', canvas: schema.project.canvas, tagId: 'temperature', index: 0 })
  gauge.name = 'Tank temperature'
  schema.components.push(gauge)
  return schema
}

test('validation diagnostics resolve component identity, field, current value, and suggested fix', () => {
  const schema = diagnosticSchema()
  schema.components[0].properties.tickCount = 99
  const diagnostics = validationDiagnostics(schema, [{ severity: 'error', code: 'gauge.ticks', message: 'Gauge ticks are invalid.', path: 'components.0.properties.tickCount' }])

  assert.equal(diagnostics[0].sourceKind, 'component')
  assert.equal(diagnostics[0].sourceId, 'gauge-temperature')
  assert.match(diagnostics[0].sourceLabel, /Tank temperature \(Gauge\)/)
  assert.equal(diagnostics[0].field, 'properties.tickCount')
  assert.equal(diagnostics[0].currentValue, '99')
  assert.match(diagnostics[0].hint, /reported field|review/i)
})

test('validation diagnostics resolve server paths that identify a data source by id', () => {
  const schema = diagnosticSchema()
  schema.dataSources.push({ id: 'source_tb', type: 'thingsboard', environmentRef: 'staging', connectorRef: 'connector-1' })
  const diagnostics = validationDiagnostics(schema, [{ severity: 'error', code: 'connector.unhealthy', message: 'Connector is offline.', path: 'dataSources.source_tb.environmentRef' }])

  assert.equal(diagnostics[0].sourceKind, 'data-source')
  assert.equal(diagnostics[0].sourceId, 'source_tb')
  assert.equal(diagnostics[0].currentValue, '"staging"')
})

test('validation diagnostics redact secret values and preserve related conflict paths', () => {
  const schema = diagnosticSchema()
  schema.dataSources[0].token = 'never-print-me'
  const diagnostics = validationDiagnostics(schema, [{
    severity: 'error',
    code: 'schema.secret',
    message: 'Secret detected.',
    path: 'dataSources.0.token',
    redacted: true,
    relatedPaths: ['dataSources.1.token'],
  }])

  assert.equal(diagnostics[0].currentValue, '[redacted]')
  assert.deepEqual(diagnostics[0].relatedPaths, ['dataSources.1.token'])
  assert.doesNotMatch(JSON.stringify(diagnostics), /never-print-me/)
})

test('validation console report and summary keep errors ahead of warnings', () => {
  const schema = diagnosticSchema()
  const diagnostics = validationDiagnostics(schema, [
    { severity: 'warning', code: 'component.bounds', message: 'Outside canvas.', path: 'components.0.position' },
    { severity: 'error', code: 'binding.broken', message: 'Missing tag.', path: 'components.0.binding.tagId' },
  ])
  const summary = validationSummary(diagnostics)
  const report = validationConsoleReport({ projectName: schema.project.name, origin: 'Publish preflight', diagnostics })

  assert.deepEqual(summary, { total: 2, errors: 1, warnings: 1, info: 0 })
  assert.equal(diagnostics[0].severity, 'error')
  assert.match(report, /PROJECT VALIDATION CONSOLE · Diagnostics/)
  assert.match(report, /Source: Component #1 · Tank temperature \(Gauge\)/)
  assert.match(report, /Fix:/)
})
