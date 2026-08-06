import { useMemo } from 'react'
import { buildChartModel, buildSeriesPath, chartPointPosition } from '../../shared/chart-data.js'

const PLOT = Object.freeze({ x: 92, y: 34, width: 870, height: 420 })

export function TelemetryChart({ tags = [], histories = {}, properties = {} }) {
  const model = useMemo(() => buildChartModel(tags, histories, properties), [histories, properties, tags])
  const yTicks = makeTicks(model.yDomain[0], model.yDomain[1], 5)
  const xTicks = makeTicks(model.xDomain[0], model.xDomain[1], 5)
  const yMinorTicks = makeTicks(model.yDomain[0], model.yDomain[1], 9).filter((_, index) => index % 2 === 1)
  const xMinorTicks = makeTicks(model.xDomain[0], model.xDomain[1], 9).filter((_, index) => index % 2 === 1)

  if (!tags.length) {
    return <div className="sb-chart-empty"><strong>NO SERIES CONFIGURED</strong><span>Select readable numeric tags in the builder inspector.</span></div>
  }

  return (
    <div className="sb-telemetry-chart">
      {properties.showLegend !== false && (
        <div className="sb-chart-legend" aria-label="Chart series">
          {model.series.map(series => {
            const latest = series.points.at(-1)
            return (
              <div key={series.id}>
                <i style={{ borderColor: series.color }} />
                <span>{series.name}</span>
                <strong>{latest ? formatNumber(latest.value) : '--'}{series.unit ? ` ${series.unit}` : ''}</strong>
              </div>
            )
          })}
        </div>
      )}
      <div className="sb-chart-plot">
        {model.pointCount === 0 ? (
          <div className="sb-chart-empty"><strong>WAITING FOR TELEMETRY</strong><span>The chart will update when timestamped numeric samples arrive.</span></div>
        ) : (
          <svg viewBox="0 0 1000 530" role="img" aria-label={`${properties.label || 'Telemetry chart'} with ${model.series.length} series and ${model.pointCount} samples`}>
            <title>{properties.label || 'Telemetry chart'}</title>
            <rect className="sb-chart-plot-bg" x={PLOT.x} y={PLOT.y} width={PLOT.width} height={PLOT.height} />
            {yMinorTicks.map(value => {
              const y = chartPointPosition({ timestamp: model.xDomain[0], value }, model, PLOT).y
              return <line className="sb-chart-grid-line is-minor" key={`ym-${value}`} x1={PLOT.x} x2={PLOT.x + PLOT.width} y1={y} y2={y} />
            })}
            {xMinorTicks.map(value => {
              const x = chartPointPosition({ timestamp: value, value: model.yDomain[0] }, model, PLOT).x
              return <line className="sb-chart-grid-line is-minor" key={`xm-${value}`} x1={x} x2={x} y1={PLOT.y} y2={PLOT.y + PLOT.height} />
            })}
            {yTicks.map(value => {
              const y = chartPointPosition({ timestamp: model.xDomain[0], value }, model, PLOT).y
              return <g key={`y-${value}`}><line className="sb-chart-grid-line" x1={PLOT.x} x2={PLOT.x + PLOT.width} y1={y} y2={y} /><line className="sb-chart-axis-tick" x1={PLOT.x - 6} x2={PLOT.x} y1={y} y2={y} /><text className="sb-chart-axis-label" x={PLOT.x - 13} y={y + 4} textAnchor="end">{formatNumber(value)}</text></g>
            })}
            {xTicks.map(value => {
              const x = chartPointPosition({ timestamp: value, value: model.yDomain[0] }, model, PLOT).x
              return <g key={`x-${value}`}><line className="sb-chart-grid-line" x1={x} x2={x} y1={PLOT.y} y2={PLOT.y + PLOT.height} /><line className="sb-chart-axis-tick" x1={x} x2={x} y1={PLOT.y + PLOT.height} y2={PLOT.y + PLOT.height + 6} /><text className="sb-chart-axis-label" x={x} y={PLOT.y + PLOT.height + 25} textAnchor="middle">{formatTimestamp(value)}</text></g>
            })}
            <text className="sb-chart-axis-title" x={PLOT.x + PLOT.width / 2} y={PLOT.y + PLOT.height + 56} textAnchor="middle">TIME</text>
            <text className="sb-chart-axis-title" x="22" y={PLOT.y + PLOT.height / 2} textAnchor="middle" transform={`rotate(-90 22 ${PLOT.y + PLOT.height / 2})`}>VALUE</text>
            {model.series.map(series => (
              <g key={series.id}>
                {series.points.length > 1 && <path className="sb-chart-series-line" d={buildSeriesPath(series.points, model, PLOT)} stroke={series.color} />}
                {series.points.slice(-1).map((point, index) => {
                  const position = chartPointPosition(point, model, PLOT)
                  return <circle className="sb-chart-series-point" key={`${point.timestamp}-${index}`} cx={position.x} cy={position.y} r="4" fill={series.color}><title>{series.name}: {formatNumber(point.value)} at {formatTimestamp(point.timestamp, true)}</title></circle>
                })}
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  )
}

function makeTicks(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  return Array.from({ length: count }, (_, index) => min + (max - min) * index / (count - 1))
}

function formatNumber(value) {
  const absolute = Math.abs(value)
  const decimals = absolute > 0 && absolute < 1 ? 3 : absolute < 100 ? 2 : 1
  return Number(value.toFixed(decimals)).toLocaleString()
}

function formatTimestamp(timestamp, includeDate = false) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return '--:--'
  return date.toLocaleString([], includeDate
    ? { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
