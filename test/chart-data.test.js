import test from 'node:test'
import assert from 'node:assert/strict'
import { buildChartModel, buildSeriesPath, buildSeriesRangePath, chartPointPosition, CHART_SERIES_COLORS } from '../shared/chart-data.js'
import { appendRuntimeHistory, seedRuntimeHistory } from '../shared/runtime-history.js'

test('runtime history seeds numeric snapshots with their telemetry timestamp', () => {
  const history = seedRuntimeHistory({
    level: { value: 12.5, timestamp: '2026-07-27T01:00:00.000Z', quality: 'good', sequence: 4 },
    state: { value: 'RUNNING', timestamp: '2026-07-27T01:00:00.000Z' },
  })
  assert.equal(history.level[0].timestamp, Date.parse('2026-07-27T01:00:00.000Z'))
  assert.equal(history.level[0].value, 12.5)
  assert.equal(history.state, undefined)
})

test('runtime history merges persisted Chart samples with the latest snapshot', () => {
  const history = seedRuntimeHistory(
    { level: { value: 12, timestamp: 3000, sequence: 3 } },
    { level: [{ value: 10, timestamp: 1000, sequence: 1 }, { value: 11, timestamp: 2000, sequence: 2 }] },
  )
  assert.deepEqual(history.level.map(point => point.value), [10, 11, 12])
})

test('runtime history orders, deduplicates, and bounds streamed samples', () => {
  const initial = seedRuntimeHistory({ level: { value: 10, timestamp: 1000, sequence: 1 } })
  const history = appendRuntimeHistory(initial, [
    { tagId: 'level', value: 30, sourceTimestamp: 3000, sequence: 3 },
    { tagId: 'level', value: 20, sourceTimestamp: 2000, sequence: 2 },
    { tagId: 'level', value: 22, sourceTimestamp: 2100, sequence: 2 },
  ], 2)
  assert.deepEqual(history.level.map(point => [point.timestamp, point.value]), [[2100, 22], [3000, 30]])
  assert.equal(initial.level.length, 1)
})

test('chart model filters by the latest telemetry window and history limit', () => {
  const tags = [{ id: 'level', name: 'Level' }]
  const histories = {
    level: [
      { timestamp: 0, value: 1 },
      { timestamp: 30 * 60_000, value: 2 },
      { timestamp: 60 * 60_000, value: 3 },
    ],
  }
  const model = buildChartModel(tags, histories, { historyLimit: 30, windowMinutes: 40 })
  assert.deepEqual(model.series[0].points.map(point => point.value), [2, 3])
  assert.equal(model.pointCount, 2)
})

test('chart x positions follow timestamp distance instead of sample index', () => {
  const tags = [{ id: 'level', name: 'Level' }]
  const histories = { level: [{ timestamp: 0, value: 1 }, { timestamp: 1000, value: 2 }, { timestamp: 4000, value: 3 }] }
  const model = buildChartModel(tags, histories, { historyLimit: 30, windowMinutes: 60 })
  const plot = { x: 0, y: 0, width: 400, height: 100 }
  const positions = model.series[0].points.map(point => chartPointPosition(point, model, plot).x)
  assert.deepEqual(positions, [0, 100, 400])
  assert.match(buildSeriesPath(model.series[0].points, model, plot), /^M0\.00,.+ L100\.00,.+ L400\.00,/)
})

test('historical Chart range uses requested timestamps and preserves bucket excursions', () => {
  const tags = [{ id: 'level', name: 'Level' }]
  const histories = { level: [{ timestamp: 2000, value: 10, min: 2, max: 18, count: 30, resolutionMs: 1000 }] }
  const model = buildChartModel(tags, histories, { historyLimit: 300, range: { from: 1000, to: 5000 } })
  assert.deepEqual(model.xDomain, [1000, 5000])
  assert.equal(model.yDomain[0] < 2, true)
  assert.equal(model.yDomain[1] > 18, true)
  assert.match(buildSeriesRangePath(model.series[0].points, model, { x: 0, y: 0, width: 400, height: 100 }), /^M100\.00,.+ L100\.00,/)
})

test('chart palette stays neutral and ignores legacy cyan accent settings', () => {
  const model = buildChartModel(
    [{ id: 'level', name: 'Level' }],
    { level: [{ timestamp: 1000, value: 50 }] },
    { accentColor: '#20c4d9' },
  )
  assert.equal(model.series[0].color, CHART_SERIES_COLORS[0])
  assert.equal(model.series[0].color, '#d8dde0')
  assert.equal(CHART_SERIES_COLORS.includes('#20c4d9'), false)
})
