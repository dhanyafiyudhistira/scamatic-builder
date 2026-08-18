export const GAUGE_START_ANGLE = 150
export const GAUGE_SWEEP_ANGLE = 240

export function normalizeGaugeProperties(properties = {}) {
  const min = finiteOr(properties.min, 0)
  const configuredMax = finiteOr(properties.max, 100)
  const max = configuredMax > min ? configuredMax : min + 1
  const span = max - min
  const lowZoneEnd = clamp(optionalFiniteOr(properties.lowZoneEnd, min + span * .3), min, max)
  const highZoneStart = clamp(optionalFiniteOr(properties.highZoneStart, min + span * .7), lowZoneEnd, max)
  const decimals = clampInteger(properties.decimals, 0, 8, 1)
  const tickCount = clampInteger(properties.tickCount, 4, 12, 10)
  return { min, max, span, lowZoneEnd, highZoneStart, decimals, tickCount }
}

export function gaugeValueState(rawValue, properties = {}) {
  const config = normalizeGaugeProperties(properties)
  const present = rawValue !== null && rawValue !== undefined && rawValue !== ''
  const input = present ? Number(rawValue) : Number.NaN
  const scale = finiteOr(properties.scale, 1)
  const offset = finiteOr(properties.offset, 0)
  const value = input * scale + offset
  const valid = Number.isFinite(input) && Number.isFinite(value)
  const clampedValue = valid ? clamp(value, config.min, config.max) : config.min
  const ratio = (clampedValue - config.min) / config.span
  return {
    ...config,
    valid,
    value: valid ? value : null,
    clampedValue,
    ratio,
    angle: GAUGE_START_ANGLE + ratio * GAUGE_SWEEP_ANGLE,
    display: valid
      ? value.toLocaleString('en-US', { minimumFractionDigits: config.decimals, maximumFractionDigits: config.decimals })
      : String(properties.fallback ?? '--'),
  }
}

export function gaugeTicks(properties = {}) {
  const config = normalizeGaugeProperties(properties)
  return Array.from({ length: config.tickCount + 1 }, (_, index) => {
    const ratio = index / config.tickCount
    const value = config.min + config.span * ratio
    return {
      value,
      ratio,
      angle: GAUGE_START_ANGLE + ratio * GAUGE_SWEEP_ANGLE,
      label: formatTick(value, config.span / config.tickCount),
    }
  })
}

export function gaugeAngleFor(value, properties = {}) {
  const config = normalizeGaugeProperties(properties)
  return GAUGE_START_ANGLE + clamp((Number(value) - config.min) / config.span, 0, 1) * GAUGE_SWEEP_ANGLE
}

export function gaugePoint(cx, cy, radius, angle) {
  const radians = Number(angle) * Math.PI / 180
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  }
}

export function gaugeArcPath(cx, cy, radius, startAngle, endAngle) {
  const sweep = Number(endAngle) - Number(startAngle)
  if (!Number.isFinite(sweep) || sweep <= 0) return ''
  const start = gaugePoint(cx, cy, radius, startAngle)
  const end = gaugePoint(cx, cy, radius, endAngle)
  return `M ${rounded(start.x)} ${rounded(start.y)} A ${radius} ${radius} 0 ${sweep > 180 ? 1 : 0} 1 ${rounded(end.x)} ${rounded(end.y)}`
}

function formatTick(value, step) {
  const decimals = Number.isInteger(step) ? 0 : Math.min(2, decimalPlaces(step))
  const normalized = Math.abs(value) < 1e-10 ? 0 : value
  return normalized.toLocaleString('en-US', { maximumFractionDigits: decimals })
}

function decimalPlaces(value) {
  const text = Math.abs(Number(value)).toFixed(8).replace(/0+$/, '')
  return text.includes('.') ? text.split('.')[1].length : 0
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isInteger(number) ? clamp(number, min, max) : fallback
}

function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function optionalFiniteOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  return finiteOr(value, fallback)
}

function rounded(value) {
  return Math.round(value * 1000) / 1000
}
