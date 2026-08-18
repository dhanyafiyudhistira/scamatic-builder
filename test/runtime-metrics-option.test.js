import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeHrefWithMetrics, runtimeMetricsEnabled } from '../shared/runtime-metrics-option.js'

test('runtime metrics are opt-in and enabled only by the explicit Runtime launch choice', () => {
  assert.equal(runtimeMetricsEnabled(''), false)
  assert.equal(runtimeMetricsEnabled('?metrics=disabled'), false)
  assert.equal(runtimeMetricsEnabled('?metrics=enabled'), true)
  assert.equal(runtimeMetricsEnabled('?view=dark&metrics=enabled'), true)
  assert.equal(runtimeMetricsEnabled('?metrics=true'), false)
})

test('Runtime launch choice preserves existing query parameters and fragments', () => {
  assert.equal(runtimeHrefWithMetrics('/runtime/mixing-unit', true), '/runtime/mixing-unit?metrics=enabled')
  assert.equal(runtimeHrefWithMetrics('/runtime/mixing-unit?view=dark#controls', false), '/runtime/mixing-unit?view=dark&metrics=disabled#controls')
  assert.equal(runtimeHrefWithMetrics('', true), '')
})
