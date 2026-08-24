import { evaluateRule } from './runtime-evaluator.js'
import { hasNumericEngineering, numericEngineering } from './numeric-tag-config.js'

export const ALARM_PRESENTATIONS = Object.freeze(['lamp', 'buzzer'])
export const ALARM_FREQUENCY_RANGE = Object.freeze({ min: 100, max: 4000 })
export const ALARM_VOLUME_RANGE = Object.freeze({ min: 0, max: 0.5 })
export const ALARM_PULSE_RANGE = Object.freeze({ min: 100, max: 5000 })
export const ALARM_RULE_MODES = Object.freeze(['inherit', 'custom'])
export const NUMERIC_ALARM_RULE_OPERATORS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'outside'])

export function normalizeAlarmProperties(properties = {}) {
  return {
    presentation: properties.presentation === 'buzzer' ? 'buzzer' : 'lamp',
    activeColor: safeColor(properties.activeColor, '#ef4444'),
    idleColor: safeColor(properties.idleColor, '#46545d'),
    flash: properties.flash !== false,
    soundEnabled: properties.soundEnabled !== false,
    frequencyHz: boundedNumber(properties.frequencyHz, 880, ALARM_FREQUENCY_RANGE),
    volume: boundedNumber(properties.volume, 0.18, ALARM_VOLUME_RANGE),
    pulseMs: Math.round(boundedNumber(properties.pulseMs, 650, ALARM_PULSE_RANGE)),
  }
}

export function evaluateAlarmState({ tag, value, quality = 'good', properties = {} } = {}) {
  const config = normalizeAlarmProperties(properties)
  const resolvedRule = resolveAlarmRule(tag, properties)
  const bound = Boolean(tag)
  const readable = quality === 'good'
  const active = bound && readable && evaluateRule(value, resolvedRule.rule)
  return {
    ...config,
    active,
    ruleSource: resolvedRule.source,
    stateLabel: !bound ? 'UNBOUND' : !readable ? String(quality || 'bad').toUpperCase() : active ? 'ALARM' : 'NORMAL',
  }
}

export function defaultNumericAlarmRule(tag) {
  const engineering = numericEngineering(tag)
  return { operator: 'gte', value: engineering.min + (engineering.max - engineering.min) * 0.8 }
}

export function normalizeNumericAlarmRule(rule, tag) {
  const engineering = numericEngineering(tag)
  const span = engineering.max - engineering.min
  const operator = NUMERIC_ALARM_RULE_OPERATORS.includes(rule?.operator) ? rule.operator : 'gte'
  if (['between', 'outside'].includes(operator)) {
    const fallbackMin = engineering.min + span * 0.2
    const fallbackMax = engineering.min + span * 0.8
    const min = Number(rule?.min)
    const max = Number(rule?.max)
    return {
      operator,
      min: Number.isFinite(min) ? min : fallbackMin,
      max: Number.isFinite(max) ? max : fallbackMax,
    }
  }
  const value = Number(rule?.value)
  return { operator, value: Number.isFinite(value) ? value : engineering.min + span * 0.8 }
}

export function numericAlarmRule(tag) {
  if (tag?.dataType !== 'number' || !tag.alarmRule || typeof tag.alarmRule !== 'object' || Array.isArray(tag.alarmRule)) return null
  const rule = normalizeNumericAlarmRule(tag.alarmRule, tag)
  if (!NUMERIC_ALARM_RULE_OPERATORS.includes(tag.alarmRule.operator)) return null
  if (['between', 'outside'].includes(rule.operator)) {
    if (!hasConfiguredNumber(tag.alarmRule.min) || !hasConfiguredNumber(tag.alarmRule.max) || rule.max < rule.min) return null
  } else if (!hasConfiguredNumber(tag.alarmRule.value)) return null
  if (hasNumericEngineering(tag)) {
    const engineering = numericEngineering(tag)
    if (['between', 'outside'].includes(rule.operator)) {
      if (rule.min < engineering.min || rule.max > engineering.max) return null
    } else if (rule.value < engineering.min || rule.value > engineering.max) return null
  }
  return rule
}

export function resolveAlarmRule(tag, properties = {}) {
  const inherited = properties.ruleMode !== 'custom' ? numericAlarmRule(tag) : null
  return inherited
    ? { rule: inherited, source: 'tag' }
    : { rule: properties.rule || { operator: 'truthy' }, source: 'component' }
}

export function describeAlarmRule(rule, unit = '') {
  if (!rule) return 'Not configured'
  const suffix = unit ? ` ${unit}` : ''
  const labels = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' }
  if (['between', 'outside'].includes(rule.operator)) {
    return `${rule.operator === 'outside' ? 'Outside' : 'Inside'} ${rule.min}${suffix} – ${rule.max}${suffix}`
  }
  return `${labels[rule.operator] || rule.operator} ${rule.value}${suffix}`
}

function boundedNumber(value, fallback, range) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(range.min, Math.min(range.max, number))
}

function safeColor(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

function hasConfiguredNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}
