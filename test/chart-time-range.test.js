import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptiveChartResolution, chartRangeBounds, chartRangePreset, normalizeChartRange } from '../shared/chart-time-range.js'

test('Chart range presets distinguish minutes from calendar-scale labels', () => {
  assert.equal(chartRangePreset('1min').durationMs, 60_000)
  assert.equal(chartRangePreset('1mo').durationMs, 30 * 24 * 60 * 60_000)
  assert.deepEqual(chartRangeBounds('30s', 100_000), {
    id: '30s',
    label: '30 s',
    from: 70_000,
    to: 100_000,
    durationMs: 30_000,
  })
})

test('Chart history ranges are bounded to one year plus clock tolerance', () => {
  const range = normalizeChartRange({ from: 1_000, to: 61_000, targetPoints: 800 }, { now: 61_000 })
  assert.equal(range.rangeMs, 60_000)
  assert.equal(range.targetPoints, 800)
  assert.throws(() => normalizeChartRange({ from: 61_000, to: 1_000 }, { now: 61_000 }))
  assert.throws(() => normalizeChartRange({ from: 0, to: 367 * 24 * 60 * 60_000 }, { now: 367 * 24 * 60 * 60_000 }))
})

test('adaptive Chart resolution keeps long ranges within a visual point budget', () => {
  assert.deepEqual(adaptiveChartResolution(30_000, 900), {
    bucketMs: 1_000,
    unit: 'second',
    binSize: 1,
    targetPoints: 900,
  })
  const yearly = adaptiveChartResolution(365 * 24 * 60 * 60_000, 900)
  assert.equal(yearly.bucketMs, 12 * 60 * 60_000)
  assert.equal(yearly.unit, 'hour')
  assert.equal(yearly.binSize, 12)
})
