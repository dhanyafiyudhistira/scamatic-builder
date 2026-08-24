export const CHART_SERIES_COLORS = Object.freeze([
  '#d8dde0',
  '#f6b73c',
  '#8bd450',
  '#ff6b8a',
  '#c4a7e7',
  '#fb923c',
  '#e879f9',
  '#f4d35e',
  '#b8c0c4',
])

export function buildChartModel(tags = [], histories = {}, properties = {}) {
  const historyLimit = clampInteger(properties.historyLimit, 30, 2000, 300)
  const windowMinutes = clampNumber(properties.windowMinutes, 1, 527_040, 60)
  const requestedRange = normalizeDisplayRange(properties.range)
  const normalized = tags.map((tag, index) => {
    const points = (histories[tag.id] || [])
      .map(point => ({
        timestamp: Number(point?.timestamp),
        value: Number(point?.value),
        quality: point?.quality || 'good',
        min: finiteOr(point?.min, point?.value),
        max: finiteOr(point?.max, point?.value),
        count: Number.isInteger(Number(point?.count)) ? Number(point.count) : 1,
        resolutionMs: Number.isFinite(Number(point?.resolutionMs)) ? Number(point.resolutionMs) : null,
      }))
      .filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
      .sort((left, right) => left.timestamp - right.timestamp)
    return {
      id: tag.id,
      name: tag.name || tag.id,
      unit: tag.unit || '',
      color: CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length],
      points,
    }
  })
  const latestTimestamp = normalized.reduce((latest, series) => Math.max(latest, series.points.at(-1)?.timestamp ?? -Infinity), -Infinity)
  const rangeTo = requestedRange?.to ?? latestTimestamp
  const rangeFrom = requestedRange?.from ?? (Number.isFinite(latestTimestamp) ? latestTimestamp - windowMinutes * 60_000 : 0)
  const series = normalized.map(item => ({
    ...item,
    points: item.points
      .filter(point => point.timestamp >= rangeFrom && point.timestamp <= rangeTo)
      .slice(-historyLimit),
  }))
  const allPoints = series.flatMap(item => item.points)
  const minTimestamp = requestedRange?.from ?? (allPoints.length ? Math.min(...allPoints.map(point => point.timestamp)) : 0)
  const maxTimestamp = requestedRange?.to ?? (allPoints.length ? Math.max(...allPoints.map(point => point.timestamp)) : 1)
  const minValue = allPoints.length ? Math.min(...allPoints.map(point => point.min)) : 0
  const maxValue = allPoints.length ? Math.max(...allPoints.map(point => point.max)) : 1
  const valuePadding = minValue === maxValue ? Math.max(1, Math.abs(minValue) * .05) : (maxValue - minValue) * .08

  return {
    series,
    pointCount: allPoints.length,
    xDomain: [minTimestamp, maxTimestamp === minTimestamp ? minTimestamp + 1 : maxTimestamp],
    yDomain: [minValue - valuePadding, maxValue + valuePadding],
  }
}

export function chartPointPosition(point, model, plot) {
  const [minX, maxX] = model.xDomain
  const [minY, maxY] = model.yDomain
  return {
    x: plot.x + (point.timestamp - minX) / (maxX - minX) * plot.width,
    y: plot.y + plot.height - (point.value - minY) / (maxY - minY) * plot.height,
  }
}

export function buildSeriesPath(points, model, plot) {
  return points.map((point, index) => {
    const position = chartPointPosition(point, model, plot)
    return `${index === 0 ? 'M' : 'L'}${position.x.toFixed(2)},${position.y.toFixed(2)}`
  }).join(' ')
}

export function buildSeriesRangePath(points, model, plot) {
  return points.flatMap(point => {
    if (!Number.isFinite(point.min) || !Number.isFinite(point.max) || point.min === point.max) return []
    const low = chartPointPosition({ timestamp: point.timestamp, value: point.min }, model, plot)
    const high = chartPointPosition({ timestamp: point.timestamp, value: point.max }, model, plot)
    return [`M${low.x.toFixed(2)},${low.y.toFixed(2)} L${high.x.toFixed(2)},${high.y.toFixed(2)}`]
  }).join(' ')
}

function clampInteger(value, min, max, fallback) {
  const number = Math.trunc(Number(value))
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function normalizeDisplayRange(range) {
  const from = Number(range?.from)
  const to = Number(range?.to)
  return Number.isFinite(from) && Number.isFinite(to) && from < to ? { from, to } : null
}

function finiteOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : Number(fallback)
}
