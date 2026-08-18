import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer as createViteServer } from 'vite'
import { createComponentInstance } from '../shared/component-registry.js'
import { GAUGE_START_ANGLE, GAUGE_SWEEP_ANGLE, gaugeAngleFor, gaugeArcPath, gaugeTicks, gaugeValueState } from '../shared/gauge.js'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'

const canvas = { width: 1920, height: 1080 }

test('Gauge inspector renders when the component is selected', async () => {
  const vite = await createViteServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  try {
    const { ComponentInspector } = await vite.ssrLoadModule('/src/platform/BuilderPanels.jsx')
    const { GaugeComponent } = await vite.ssrLoadModule('/src/platform/RuntimeCanvas.jsx')
    const tag = {
      id: 'temperature',
      name: 'Temperature',
      path: 'temperature',
      dataType: 'number',
      access: 'read',
      sourceId: 'source_mock',
      engineering: { min: -60, max: 60, unit: '°C', decimals: 1 },
    }
    const gauge = createComponentInstance('gauge', { id: 'gauge-1', canvas, tagId: tag.id, index: 0 })
    const markup = renderToStaticMarkup(createElement(ComponentInspector, {
      component: gauge,
      tags: [tag],
      onChange: () => {},
      onDelete: () => {},
      onDuplicate: () => {},
    }))

    assert.match(markup, /Gauge scale and appearance/)
    assert.match(markup, /°C/)

    const legacyGauge = { ...gauge, properties: { ...gauge.properties, unitMode: undefined, suffix: '%' } }
    const runtimeMarkup = renderToStaticMarkup(createElement(GaugeComponent, { component: legacyGauge, tag, value: 23.4 }))
    assert.match(runtimeMarkup, /class="sb-gauge-unit"[^>]*>°C<\/text>/)
    assert.doesNotMatch(runtimeMarkup, /class="sb-gauge-unit"[^>]*>%<\/text>/)
  } finally {
    await vite.close()
  }
})

test('gauge maps transformed telemetry into a bounded needle angle and digital value', () => {
  const properties = { min: -60, max: 60, scale: 2, offset: -10, decimals: 1, tickCount: 12 }
  const state = gaugeValueState(23.15, properties)
  assert.equal(state.value, 36.3)
  assert.equal(state.display, '36.3')
  assert.equal(state.ratio, .8025)
  assert.equal(state.angle, GAUGE_START_ANGLE + .8025 * GAUGE_SWEEP_ANGLE)

  const belowRange = gaugeValueState(-100, properties)
  assert.equal(belowRange.clampedValue, -60)
  assert.equal(belowRange.angle, GAUGE_START_ANGLE)

  const invalid = gaugeValueState(null, { ...properties, fallback: 'N/A' })
  assert.equal(invalid.valid, false)
  assert.equal(invalid.display, 'N/A')
})

test('gauge produces stable ticks, threshold angles, and SVG arc paths', () => {
  const properties = { min: -60, max: 60, lowZoneEnd: -10, highZoneStart: 30, tickCount: 12 }
  const ticks = gaugeTicks(properties)
  assert.equal(ticks.length, 13)
  assert.deepEqual([ticks[0].label, ticks.at(-1).label], ['-60', '60'])
  assert.ok(gaugeAngleFor(properties.lowZoneEnd, properties) < gaugeAngleFor(properties.highZoneStart, properties))
  assert.match(gaugeArcPath(100, 100, 78, GAUGE_START_ANGLE, GAUGE_START_ANGLE + GAUGE_SWEEP_ANGLE), /^M .+ A 78 78 0 1 1 /)
})

test('gauge schema validation rejects unsafe ranges, zones, precision, and tick counts', () => {
  const schema = createProjectSchema({ id: 'gauge-project', name: 'Gauge', slug: 'gauge' })
  schema.tags.push({ id: 'temperature', name: 'Temperature', path: 'temperature', dataType: 'number', access: 'read', sourceId: 'source_mock' })
  const gauge = createComponentInstance('gauge', { id: 'gauge-1', canvas, tagId: 'temperature', index: 0 })
  gauge.properties = { ...gauge.properties, rangeMode: 'custom', min: 100, max: 0, lowZoneEnd: 90, highZoneStart: 10, decimals: 9, tickCount: 2 }
  schema.components.push(gauge)

  const issueCodes = new Set(validateProjectSchema(schema).map(issue => issue.code))
  assert.equal(issueCodes.has('gauge.range'), true)
  assert.equal(issueCodes.has('gauge.zones'), true)
  assert.equal(issueCodes.has('gauge.decimals'), true)
  assert.equal(issueCodes.has('gauge.ticks'), true)
})
