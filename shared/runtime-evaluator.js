import { commandStatusPresentation, isPendingCommandStatus } from './command-lifecycle.js'
import { resolveNumericRange } from './numeric-tag-config.js'

export const RULE_OPERATORS = ['truthy', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'outside', 'contains']
const BLOCKING_COMMAND_QUALITIES = new Set(['disconnected', 'stale', 'bad'])

export function commandUiState({
  tag,
  quality = 'good',
  editable = false,
  hasCommandHandler = true,
  permitted = true,
  connectionAvailable = true,
  commandState = 'idle',
  interlockLabel = '',
} = {}) {
  const writable = Boolean(tag && ['write', 'read-write'].includes(tag.access))
  const requiresTelemetry = tag?.access !== 'write'
  const qualityBlocked = requiresTelemetry && BLOCKING_COMMAND_QUALITIES.has(quality)
  const disabled = editable || !hasCommandHandler || !writable || !permitted || !connectionAvailable || qualityBlocked || Boolean(interlockLabel) || isPendingCommandStatus(commandState) || commandState === 'pending'

  let label = commandState === 'idle' ? 'IDLE' : commandStatusPresentation(commandState).label
  if (!tag) label = 'UNBOUND'
  else if (!writable) label = 'READ ONLY'
  else if (!permitted) label = 'NO PERMISSION'
  else if (!connectionAvailable) label = 'DISCONNECTED'
  else if (qualityBlocked) label = String(quality).toUpperCase()
  else if (interlockLabel) label = interlockLabel

  return { disabled, label, writable, requiresTelemetry, qualityBlocked, interlocked: Boolean(interlockLabel) }
}

export function tuningInteractionState({
  dirty = false,
  editing = false,
  commandState = 'idle',
  fallbackLabel = 'IDLE',
} = {}) {
  const pending = isPendingCommandStatus(commandState) || commandState === 'pending'
  const normalized = commandStatusPresentation(commandState)
  const syncFromLive = !dirty && !editing && !pending
  const status = pending
    ? 'SENDING'
    : normalized.state === 'acknowledged' || commandState === 'ok'
      ? 'APPLIED'
      : normalized.state === 'rejected'
        ? 'REJECTED'
        : normalized.state === 'timeout'
          ? 'TIMEOUT'
          : normalized.state === 'failed' || commandState === 'error'
        ? 'FAILED'
        : editing
          ? 'EDITING'
          : dirty
            ? 'APPLY'
            : fallbackLabel
  return { syncFromLive, status }
}

export function evaluateRule(value, rule = { operator: 'truthy' }) {
  const operator = rule?.operator || 'truthy'
  switch (operator) {
    case 'truthy': return value === true || value === 1 || value === 'true' || value === '1'
    case 'eq': return value === rule.value || String(value) === String(rule.value)
    case 'neq': return !(value === rule.value || String(value) === String(rule.value))
    case 'gt': return Number(value) > Number(rule.value)
    case 'gte': return Number(value) >= Number(rule.value)
    case 'lt': return Number(value) < Number(rule.value)
    case 'lte': return Number(value) <= Number(rule.value)
    case 'between': return Number(value) >= Number(rule.min) && Number(value) <= Number(rule.max)
    case 'outside': return Number(value) < Number(rule.min) || Number(value) > Number(rule.max)
    case 'contains': return String(value ?? '').includes(String(rule.value ?? ''))
    default: return false
  }
}

export function formatRuntimeValue(rawValue, properties = {}) {
  if (rawValue === null || rawValue === undefined || (typeof rawValue === 'number' && !Number.isFinite(rawValue))) {
    return properties.fallback ?? '--'
  }
  if (typeof rawValue === 'number') {
    const scale = finiteOr(properties.scale, 1)
    const offset = finiteOr(properties.offset, 0)
    let value = rawValue * scale + offset
    if (Array.isArray(properties.clamp) && properties.clamp.length === 2) {
      value = Math.min(Number(properties.clamp[1]), Math.max(Number(properties.clamp[0]), value))
    }
    const decimals = Math.max(0, Math.min(8, Number.parseInt(properties.decimals ?? 1, 10)))
    // Keep published screens identical across operator workstations and the server.
    return `${properties.prefix || ''}${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${properties.suffix || ''}`
  }
  return `${properties.prefix || ''}${String(rawValue)}${properties.suffix || ''}`
}

export function valueSeverity(rawValue, properties = {}) {
  const value = Number(rawValue)
  if (!Number.isFinite(value)) return 'invalid'
  const criticalHigh = nullableNumber(properties.criticalHigh)
  const warningHigh = nullableNumber(properties.warningHigh)
  const criticalLow = nullableNumber(properties.criticalLow)
  const warningLow = nullableNumber(properties.warningLow)
  if ((criticalHigh !== null && value >= criticalHigh) || (criticalLow !== null && value <= criticalLow)) return 'critical'
  if ((warningHigh !== null && value >= warningHigh) || (warningLow !== null && value <= warningLow)) return 'warning'
  return 'normal'
}

export function initialMockValue(tag) {
  if (tag?.dataType === 'boolean') return false
  if (tag?.dataType === 'number') return 0
  if (tag?.dataType === 'datetime') return new Date().toISOString()
  return ''
}

export function executeMockCommand(component, tag, currentValue, requestedValue, context = {}) {
  if (!tag || !['write', 'read-write'].includes(tag.access)) {
    return { ok: false, message: 'Tag is not writable.', value: currentValue }
  }
  if (component.type === 'operation-shifter') return evaluateOperationShift(component, tag, requestedValue, context.components)
  if (component.type === 'tuning-slider') {
    if (tag.dataType !== 'number') return { ok: false, message: 'Tuning sliders require a numeric tag.', value: currentValue }
    const value = Number(requestedValue)
    const range = resolveNumericRange(tag, component.properties, 'write')
    const min = range.min
    const max = range.max
    const step = range.step
    if (!Number.isFinite(value)) return { ok: false, message: 'Tuning value must be a finite number.', value: currentValue }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || !Number.isFinite(step) || step <= 0) {
      return { ok: false, message: 'Tuning range configuration is invalid.', value: currentValue }
    }
    if (value < min || value > max) return { ok: false, message: `Tuning value must be between ${min} and ${max}.`, value: currentValue }
    const steps = (value - min) / step
    if (Math.abs(steps - Math.round(steps)) > 1e-7) return { ok: false, message: `Tuning value must follow a step of ${step}.`, value: currentValue }
    return { ok: true, message: 'Mock tuning command acknowledged.', value: Number(value.toFixed(10)) }
  }
  const action = component.properties?.action || 'toggle-boolean'
  if (action === 'toggle-boolean') return { ok: true, message: 'Mock command acknowledged.', value: !Boolean(currentValue) }
  if (action === 'set-value') return { ok: true, message: 'Mock command acknowledged.', value: coerceForTag(component.properties?.payload, tag.dataType) }
  if (action === 'pulse') return { ok: true, message: 'Mock pulse acknowledged.', value: true, resetAfterMs: Number(component.properties?.pulseMs || 300) }
  return { ok: false, message: `Unsupported mock action: ${action}.`, value: currentValue }
}

export function evaluateOperationShift(component, tag, requestedValue, components = []) {
  if (!['string', 'enum'].includes(tag?.dataType)) return { ok: false, message: 'Operation Shifter requires a writable string or enum tag.', value: null }
  const mode = String(requestedValue?.mode || '').toLowerCase()
  if (!['manual', 'auto', 'reset'].includes(mode)) return { ok: false, message: 'Operation mode must be manual, auto, or reset.', value: null }
  const selectionProvided = Array.isArray(requestedValue?.enabledStepIds)
  const enabledStepIds = new Set(selectionProvided ? requestedValue.enabledStepIds.map(String).slice(0, 64) : [])
  const componentById = new Map((components || []).map(item => [item.id, item]))
  const configured = Array.isArray(component.properties?.autoSequence) ? component.properties.autoSequence : []
  const sequence = mode === 'auto' ? configured.flatMap((step, index) => {
    const stepId = String(step?.id || `step-${index + 1}`)
    if (step?.enabled === false || (selectionProvided && !enabledStepIds.has(stepId))) return []
    const target = componentById.get(step?.componentId)
    const rpcMethod = String(target?.properties?.rpcMethod || step?.rpcMethod || '')
    if (!target || target.type !== 'control-button' || !rpcMethod) return []
    return [{
      id: stepId,
      order: index + 1,
      componentId: target.id,
      rpcMethod,
      value: step?.value !== false,
      delayMs: Math.max(0, Math.min(3_600_000, Number(step?.delayMs) || 0)),
    }]
  }) : []
  if (mode === 'auto' && !sequence.length) return { ok: false, message: 'AUTO mode requires at least one enabled, valid sequence step.', value: null }
  return {
    ok: true,
    message: mode === 'reset' ? 'Shutdown/reset requested; recipe retained for restart.' : `${mode.toUpperCase()} operation mode requested.`,
    value: {
      mode,
      sequence,
      shutdown: mode === 'reset',
      steady: mode === 'reset',
    },
  }
}

function coerceForTag(value, type) {
  if (type === 'boolean') return value === true || value === 'true' || value === 1 || value === '1'
  if (type === 'number') return Number(value)
  return String(value ?? '')
}

function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
