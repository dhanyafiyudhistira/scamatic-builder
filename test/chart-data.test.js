import test from 'node:test'
import assert from 'node:assert/strict'
import { buildChartModel, buildSeriesPath, buildSeriesRangePath, chartPointPosition, CHART_SERIES_COLORS } from '../shared/chart-data.js'
import { appendRuntimeHistory, normalizeTelemetrySample, seedRuntimeHistory } from '../shared/runtime-history.js'

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

test('runtime history appends ordered samples without mutating the previous rolling window', () => {
  const initial = {
    level: [
      { timestamp: 1000, value: 10, quality: 'good', sequence: 1 },
      { timestamp: 2000, value: 20, quality: 'good', sequence: 2 },
      { timestamp: 3000, value: 30, quality: 'good', sequence: 3 },
    ],
  }
  const originalPoints = initial.level
  const history = appendRuntimeHistory(initial, [
    { tagId: 'level', value: 40, sourceTimestamp: 4000, sequence: 4 },
    { tagId: 'level', value: 50, sourceTimestamp: 5000, sequence: 5 },
  ], 3)

  assert.deepEqual(history.level.map(point => [point.timestamp, point.value]), [[3000, 30], [4000, 40], [5000, 50]])
  assert.strictEqual(initial.level, originalPoints)
  assert.deepEqual(initial.level.map(point => point.value), [10, 20, 30])
})

test('runtime history falls back safely for corrections, late events, and sequence-less samples', () => {
  const initial = {
    level: [
      { timestamp: 1000, value: 10, quality: 'good', sequence: 1 },
      { timestamp: 3000, value: 30, quality: 'good', sequence: 3 },
    ],
  }
  const history = appendRuntimeHistory(initial, [
    { tagId: 'level', value: 20, sourceTimestamp: 2000, sequence: 2 },
    { tagId: 'level', value: 33, sourceTimestamp: 3300, sequence: 3 },
    { tagId: 'level', value: 40, sourceTimestamp: 4000 },
    { tagId: 'level', value: 44, sourceTimestamp: 4000 },
  ])

  assert.deepEqual(history.level.map(point => [point.timestamp, point.value, point.sequence]), [
    [1000, 10, 1],
    [2000, 20, 2],
    [3300, 33, 3],
    [4000, 44, null],
  ])
  assert.deepEqual(initial.level.map(point => point.value), [10, 30])
})

test('runtime history repairs an unsorted input before using ordered appends', () => {
  const initial = {
    level: [
      { timestamp: 3000, value: 30, quality: 'good', sequence: 3 },
      { timestamp: 1000, value: 10, quality: 'good', sequence: 1 },
    ],
  }
  const history = appendRuntimeHistory(initial, [
    { tagId: 'level', value: 40, sourceTimestamp: 4000, sequence: 4 },
    { tagId: 'level', value: 50, sourceTimestamp: 5000, sequence: 5 },
  ])

  assert.deepEqual(history.level.map(point => point.timestamp), [1000, 3000, 4000, 5000])
})

test('runtime history carries fallback sequence metadata safely into the next batch', () => {
  const initial = seedRuntimeHistory({ level: { value: 10, timestamp: 1000, sequence: 1 } })
  const withLateHighSequence = appendRuntimeHistory(initial, [
    { tagId: 'level', value: 100, sourceTimestamp: 500, sequence: 100 },
  ])
  const corrected = appendRuntimeHistory(withLateHighSequence, [
    { tagId: 'level', value: 101, sourceTimestamp: 2000, sequence: 100 },
  ])

  assert.deepEqual(corrected.level.map(point => [point.timestamp, point.value, point.sequence]), [
    [1000, 10, 1],
    [2000, 101, 100],
  ])
})

test('optimized runtime history matches the legacy algorithm across deterministic mixed streams', () => {
  let optimized = {}
  let reference = {}
  let randomState = 0x5ca1ab1e
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
    return randomState / 0x100000000
  }
  const tags = ['level', 'pressure', 'flow']

  for (let batchIndex = 0; batchIndex < 250; batchIndex += 1) {
    const events = Array.from({ length: 1 + Math.floor(random() * 6) }, () => {
      const timestamp = 1000 + Math.floor(random() * 120)
      const includeSequence = random() > 0.25
      return {
        tagId: tags[Math.floor(random() * tags.length)],
        value: Math.round(random() * 10_000) / 100,
        sourceTimestamp: timestamp,
        ...(includeSequence ? { sequence: Math.floor(random() * 80) } : {}),
        quality: random() > 0.1 ? 'good' : 'stale',
      }
    })
    optimized = appendRuntimeHistory(optimized, events, 40)
    reference = appendRuntimeHistoryReference(reference, events, 40)
    assert.deepEqual(optimized, reference)
  }
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

function appendRuntimeHistoryReference(previous, events, limit) {
  const safeLimit = Math.max(1, Math.min(2000, Math.trunc(Number(limit)) || 2000))
  let next = previous
  const touched = new Set()
  for (const event of events) {
    const tagId = typeof event?.tagId === 'string' ? event.tagId : ''
    const sample = normalizeTelemetrySample(event)
    if (!tagId || !sample) continue
    if (next === previous) next = { ...previous }
    const current = touched.has(tagId) ? next[tagId] : [...(previous[tagId] || [])]
    touched.add(tagId)
    const duplicateIndex = current.findIndex(item =>
      sample.sequence != null && item.sequence != null
        ? item.sequence === sample.sequence
        : item.timestamp === sample.timestamp
    )
    if (duplicateIndex >= 0) current[duplicateIndex] = sample
    else current.push(sample)
    current.sort((left, right) => left.timestamp - right.timestamp)
    next[tagId] = current.slice(-safeLimit)
  }
  return next
}
