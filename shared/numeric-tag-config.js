export const NUMERIC_RANGE_MODES = Object.freeze(['inherit', 'custom'])
export const NUMERIC_FORMAT_MODES = Object.freeze(['number', 'percentage'])
export const NUMERIC_UNIT_MODES = Object.freeze(['inherit', 'custom'])
export const DEFAULT_ENGINEERING = Object.freeze({ min: 0, max: 100, unit: '', decimals: 1 })
export const DEFAULT_WRITE_CONSTRAINTS = Object.freeze({ min: 0, max: 100, step: 1 })

export function hasNumericEngineering(tag) {
  const min = Number(tag?.engineering?.min)
  const max = Number(tag?.engineering?.max)
  return tag?.dataType === 'number' && Number.isFinite(min) && Number.isFinite(max) && max > min
}

export function numericEngineering(tag, fallback = DEFAULT_ENGINEERING) {
  const source = hasNumericEngineering(tag) ? tag.engineering : fallback
  const numberFormat = numericFormatMode(tag)
  const min = finiteOr(source?.min, DEFAULT_ENGINEERING.min)
  const configuredMax = finiteOr(source?.max, DEFAULT_ENGINEERING.max)
  const max = configuredMax > min ? configuredMax : min + 100
  return {
    min,
    max,
    unit: numberFormat === 'percentage' ? '%' : typeof source?.unit === 'string' ? source.unit.slice(0, 40) : '',
    decimals: boundedInteger(source?.decimals, 0, 8, DEFAULT_ENGINEERING.decimals),
  }
}

export function numericFormatMode(tag) {
  if (NUMERIC_FORMAT_MODES.includes(tag?.numberFormat)) return tag.numberFormat
  return String(tag?.engineering?.unit || '').trim() === '%' ? 'percentage' : 'number'
}

export function numericWriteConstraints(tag) {
  const engineering = numericEngineering(tag)
  const source = tag?.writeConstraints
  const configuredMin = Number(source?.min)
  const configuredMax = Number(source?.max)
  const validRange = source && typeof source === 'object' && !Array.isArray(source)
    && Number.isFinite(configuredMin) && Number.isFinite(configuredMax)
    && configuredMin >= engineering.min && configuredMax <= engineering.max && configuredMax > configuredMin
  const min = validRange ? configuredMin : engineering.min
  const max = validRange ? configuredMax : engineering.max
  const configuredStep = Number(source?.step)
  const step = Number.isFinite(configuredStep) && configuredStep > 0 && configuredStep <= max - min ? configuredStep : Math.min(DEFAULT_WRITE_CONSTRAINTS.step, max - min)
  return { min, max, step: Math.max(Number.EPSILON, step) }
}

export function resolveNumericRange(tag, properties = {}, purpose = 'display') {
  const inherited = purpose === 'write' ? numericWriteConstraints(tag) : numericEngineering(tag)
  const mode = properties.rangeMode === 'inherit' ? 'inherit' : 'custom'
  if (mode === 'inherit' && hasNumericEngineering(tag)) return { ...inherited, mode, source: 'tag' }

  const configuredMin = Number(properties.min)
  const configuredMax = Number(properties.max)
  if (!Number.isFinite(configuredMin) || !Number.isFinite(configuredMax) || configuredMax <= configuredMin) {
    return { ...inherited, mode, source: 'tag-fallback' }
  }

  if (purpose !== 'write' || !hasNumericEngineering(tag)) {
    const step = validStep(properties.step, configuredMax - configuredMin, inherited.step)
    return { ...inherited, min: configuredMin, max: configuredMax, ...(step ? { step } : {}), mode, source: mode === 'inherit' ? 'component-fallback' : 'component' }
  }

  const min = Math.max(inherited.min, configuredMin)
  const max = Math.min(inherited.max, configuredMax)
  if (max <= min) return { ...inherited, mode, source: 'tag-fallback' }
  const configuredStep = Number(properties.step)
  const validCustomStep = Number.isFinite(configuredStep) && configuredStep >= inherited.step
    && configuredStep <= max - min
    && Math.abs(configuredStep / inherited.step - Math.round(configuredStep / inherited.step)) <= 1e-7
  const step = validCustomStep ? configuredStep : inherited.step
  return { ...inherited, min, max, step, mode, source: 'component-narrowed' }
}

export function resolveGaugeZones(range, properties = {}) {
  const lowZoneEnd = Number(properties.lowZoneEnd)
  const highZoneStart = Number(properties.highZoneStart)
  const valid = Number.isFinite(lowZoneEnd) && Number.isFinite(highZoneStart)
    && lowZoneEnd >= range.min && highZoneStart <= range.max && lowZoneEnd <= highZoneStart
  if (valid) return { lowZoneEnd, highZoneStart, source: 'component' }
  const span = range.max - range.min
  return { lowZoneEnd: range.min + span * .3, highZoneStart: range.min + span * .7, source: 'range-default' }
}

export function numericDisplayProperties(tag, properties = {}) {
  const engineering = numericEngineering(tag)
  const suffix = typeof properties.suffix === 'string' && properties.suffix.length ? properties.suffix : engineering.unit
  const hasConfiguredDecimals = properties.decimals !== null && properties.decimals !== undefined && properties.decimals !== ''
  const decimals = hasConfiguredDecimals && Number.isInteger(Number(properties.decimals))
    ? boundedInteger(properties.decimals, 0, 8, engineering.decimals)
    : engineering.decimals
  return { ...properties, suffix, decimals }
}

export function numericDisplayUnit(tag, properties = {}, defaultMode = 'inherit') {
  const mode = NUMERIC_UNIT_MODES.includes(properties.unitMode) ? properties.unitMode : defaultMode
  if (mode === 'custom') return typeof properties.suffix === 'string' ? properties.suffix.slice(0, 40) : ''
  return numericEngineering(tag).unit
}

export function transformedNumericValue(rawValue, properties = {}) {
  const input = Number(rawValue)
  if (!Number.isFinite(input)) return null
  const value = input * finiteOr(properties.scale, 1) + finiteOr(properties.offset, 0)
  return Number.isFinite(value) ? value : null
}

export function numericValueOutOfRange(tag, rawValue, properties = {}) {
  if (!hasNumericEngineering(tag)) return false
  const value = transformedNumericValue(rawValue, properties)
  if (value === null) return false
  const engineering = numericEngineering(tag)
  return value < engineering.min || value > engineering.max
}

export function normalizeNumericTagConfiguration(tag, hints = {}) {
  if (tag?.dataType !== 'number') return tag
  const engineering = numericEngineering(
    { ...tag, engineering: hasNumericEngineering(tag) ? tag.engineering : hints.engineering },
    hints.engineering || DEFAULT_ENGINEERING,
  )
  const hintedWrite = hints.writeConstraints || { min: engineering.min, max: engineering.max, step: DEFAULT_WRITE_CONSTRAINTS.step }
  const normalizedTag = { ...tag, numberFormat: numericFormatMode(tag), engineering }
  if (tag.writeConstraints || tag.access !== 'read') {
    normalizedTag.writeConstraints = normalizeWriteConstraints(tag.writeConstraints || hintedWrite, engineering)
  }
  return normalizedTag
}

function normalizeWriteConstraints(source, engineering) {
  const configuredMin = Number(source?.min)
  const configuredMax = Number(source?.max)
  const validRange = Number.isFinite(configuredMin) && Number.isFinite(configuredMax)
    && configuredMin >= engineering.min && configuredMax <= engineering.max && configuredMax > configuredMin
  const min = validRange ? configuredMin : engineering.min
  const max = validRange ? configuredMax : engineering.max
  const step = validStep(source?.step, max - min, Math.min(DEFAULT_WRITE_CONSTRAINTS.step, max - min))
  return { min, max, step: Math.max(Number.EPSILON, step) }
}

function validStep(value, span, fallback) {
  const number = Number(value)
  if (Number.isFinite(number) && number > 0 && number <= span) return number
  const safeFallback = Number(fallback)
  return Number.isFinite(safeFallback) && safeFallback > 0 && safeFallback <= span ? safeFallback : Math.max(Number.EPSILON, span)
}

function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isInteger(number) ? clamp(number, min, max) : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
