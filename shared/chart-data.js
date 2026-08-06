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
  const windowMinutes = clampNumber(properties.windowMinutes, 1, 1440, 60)
  const normalized = tags.map((tag, index) => {
    const points = (histories[tag.id] || [])
      .map(point => ({ timestamp: Number(point?.timestamp), value: Number(point?.value), quality: point?.quality || 'good' }))
      .filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-historyLimit)
    return {
      id: tag.id,
      name: tag.name || tag.id,
      unit: tag.unit || '',
      color: CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length],
      points,
    }
  })
  const latestTimestamp = normalized.reduce((latest, series) => Math.max(latest, series.points.at(-1)?.timestamp ?? -Infinity), -Infinity)
  const earliestTimestamp = Number.isFinite(latestTimestamp) ? latestTimestamp - windowMinutes * 60_000 : 0
  const series = normalized.map(item => ({ ...item, points: item.points.filter(point => point.timestamp >= earliestTimestamp) }))
  const allPoints = series.flatMap(item => item.points)
  const minTimestamp = allPoints.length ? Math.min(...allPoints.map(point => point.timestamp)) : 0
  const maxTimestamp = allPoints.length ? Math.max(...allPoints.map(point => point.timestamp)) : 1
  const minValue = allPoints.length ? Math.min(...allPoints.map(point => point.value)) : 0
  const maxValue = allPoints.length ? Math.max(...allPoints.map(point => point.value)) : 1
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

function clampInteger(value, min, max, fallback) {
  const number = Math.trunc(Number(value))
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}
