import { COMPONENT_REGISTRY } from './component-registry.js'
import { RULE_OPERATORS } from './runtime-evaluator.js'
import { CONTROL_POPUP_CHILD_TYPES, CONTROL_POPUP_MAX_CHILDREN, CONTROL_POPUP_TYPE } from './control-popup.js'
import { MAX_STALE_AFTER_MS, MIN_STALE_AFTER_MS, normalizeTagFreshness, TAG_FRESHNESS_MODES } from './tag-freshness.js'
import { RUNTIME_PROFILES, runtimeProfile } from './runtime-profile.js'
import { hasNumericEngineering, normalizeNumericTagConfiguration, numericEngineering, numericWriteConstraints, NUMERIC_FORMAT_MODES, NUMERIC_RANGE_MODES, resolveGaugeZones, resolveNumericRange } from './numeric-tag-config.js'
import { ALARM_FREQUENCY_RANGE, ALARM_PRESENTATIONS, ALARM_PULSE_RANGE, ALARM_RULE_MODES, ALARM_VOLUME_RANGE, NUMERIC_ALARM_RULE_OPERATORS } from './alarm.js'

export const PROJECT_SCHEMA_VERSION = '1.6.0'
export const LEGACY_PROJECT_SCHEMA_VERSIONS = Object.freeze(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0'])
export const COMPONENT_TYPES = Object.keys(COMPONENT_REGISTRY)

const COMMAND_COMPONENT_TYPES = new Set(['control-button', 'tuning-slider', 'operation-shifter'])
const COMMAND_CONFIRMATIONS = new Set(['none', 'single'])
const COMMAND_ROLES = new Set(['VIEWER', 'EDITOR', 'OPERATOR', 'ADMIN', 'OWNER'])
const CONTROL_ACTIONS = new Set(['toggle-boolean', 'set-value', 'pulse'])

export function createProjectSchema({ id, name, slug, width = 1920, height = 1080 }) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    project: {
      id,
      name,
      slug,
      runtimeProfile: 'simulation',
      canvas: { width, height, background: '#101418' },
      svgAssetId: null,
    },
    dataSources: [{ id: 'source_mock', type: 'mock', environmentRef: 'development', connectorRef: null }],
    tags: [],
    components: [],
  }
}

export function validateProjectSchema(schema, { requireAsset = false } = {}) {
  const issues = []
  const addIssue = (severity, code, message, path = '', details = {}) => issues.push({ severity, code, message, path, ...details })
  const error = (code, message, path = '', details) => addIssue('error', code, message, path, details)
  const warning = (code, message, path = '', details) => addIssue('warning', code, message, path, details)

  if (!isPlainObject(schema)) {
    error('schema.invalid', 'Project schema must be a plain object.', '', { hint: 'Reload the project or import a JSON object with project, dataSources, tags, and components fields.' })
    return issues
  }
  if (schema.schemaVersion !== PROJECT_SCHEMA_VERSION && !LEGACY_PROJECT_SCHEMA_VERSIONS.includes(schema.schemaVersion)) {
    error('schema.version', `Unsupported schema version: ${schema.schemaVersion ?? 'missing'}.`, 'schemaVersion')
  }
  if (!isPlainObject(schema.project)) {
    error('project.invalid', 'Project configuration must be an object.', 'project')
  } else {
    if (!boundedText(schema.project.id, 200)) error('project.identity', 'Project id is required and must contain at most 200 characters.', 'project.id')
    if (!boundedText(schema.project.name, 160)) error('project.identity', 'Project name is required and must contain at most 160 characters.', 'project.name')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(schema.project.slug || '')) || String(schema.project.slug).length > 80) {
      error('project.identity', 'Project slug must use lowercase letters, numbers, and single hyphens only.', 'project.slug')
    }
  }
  if (!RUNTIME_PROFILES.includes(schema.project?.runtimeProfile)) {
    error('project.runtimeProfile', 'Runtime profile must be simulation, real, or monitor.', 'project.runtimeProfile')
  }

  const canvas = schema.project?.canvas
  if (!canvas || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width < 320 || canvas.height < 240) {
    error('canvas.invalid', 'Canvas dimensions must be finite and at least 320 × 240.', 'project.canvas')
  }
  if (canvas?.background != null && !boundedText(canvas.background, 120)) error('canvas.background', 'Canvas background must be a non-empty CSS color value no longer than 120 characters.', 'project.canvas.background')
  if (requireAsset && !schema.project?.svgAssetId) {
    error('asset.missing', 'A sanitized SVG asset is required before publish.', 'project.svgAssetId')
  }

  const tags = Array.isArray(schema.tags) ? schema.tags : []
  if (!Array.isArray(schema.tags)) error('tags.invalid', 'Tags must be an array.', 'tags')
  const tagIds = new Map()
  const tagPaths = new Map()
  const sources = Array.isArray(schema.dataSources) ? schema.dataSources : []
  const sourceIds = new Map()
  if (!Array.isArray(schema.dataSources)) error('sources.invalid', 'Data sources must be an array.', 'dataSources')
  sources.forEach((source, index) => {
    const path = `dataSources.${index}`
    if (!isPlainObject(source)) {
      error('source.invalid', 'Every data source must be an object.', path)
      return
    }
    if (!boundedText(source.id, 200)) error('source.id', 'Every data source requires an id no longer than 200 characters.', `${path}.id`)
    else if (sourceIds.has(source.id)) error('source.id', `Data source id “${source.id}” is duplicated.`, `${path}.id`, { relatedPaths: [`dataSources.${sourceIds.get(source.id)}.id`] })
    else sourceIds.set(source.id, index)
    if (!['mock', 'thingsboard'].includes(source?.type)) error('source.type', `Unsupported data source type: ${source?.type ?? 'missing'}.`, `${path}.type`)
    if (!['development', 'staging', 'production'].includes(source?.environmentRef || 'development')) error('source.environment', 'Invalid connector environment.', `${path}.environmentRef`)
    if (source?.type !== 'mock' && !boundedText(source?.connectorRef, 200)) error('source.connector', 'Non-mock data sources require a connectorRef.', `${path}.connectorRef`)
  })
  const profile = runtimeProfile(schema)
  if (['real', 'monitor'].includes(profile) && !sources.some(source => source?.type && source.type !== 'mock')) {
    error('profile.liveSource', `${profile === 'real' ? 'REAL PLC' : 'MONITOR ONLY'} requires at least one live data source.`, 'dataSources')
  }
  tags.forEach((tag, index) => {
    const path = `tags.${index}`
    if (!isPlainObject(tag)) {
      error('tag.invalid', 'Every tag must be an object.', path)
      return
    }
    if (!boundedText(tag.id, 200)) error('tag.id', 'Every tag requires an id no longer than 200 characters.', `${path}.id`)
    else if (tagIds.has(tag.id)) error('tag.id', `Tag id “${tag.id}” is duplicated.`, `${path}.id`, { relatedPaths: [`tags.${tagIds.get(tag.id)}.id`] })
    else tagIds.set(tag.id, index)
    if (!boundedText(tag.name, 160)) error('tag.name', 'Every tag requires a display name no longer than 160 characters.', `${path}.name`)
    if (!boundedText(tag.path, 255)) error('tag.path', 'Every tag requires a path no longer than 255 characters.', `${path}.path`)
    else if (tagPaths.has(tag.path)) error('tag.path', `Tag path “${tag.path}” is duplicated and would map two tags to the same signal.`, `${path}.path`, { relatedPaths: [`tags.${tagPaths.get(tag.path)}.path`] })
    else tagPaths.set(tag.path, index)
    if (!['boolean', 'number', 'string', 'enum', 'datetime'].includes(tag?.dataType)) {
      error('tag.type', `Unsupported data type for tag ${tag?.name || index}.`, `${path}.dataType`)
    }
    if (!['read', 'write', 'read-write'].includes(tag?.access)) {
      error('tag.access', `Invalid access mode for tag ${tag?.name || index}.`, `${path}.access`)
    }
    if (!tag?.sourceId || !sourceIds.has(tag.sourceId)) error('tag.source', `Tag references missing data source: ${tag?.sourceId ?? 'missing'}.`, `${path}.sourceId`)
    const source = sources.find(item => item.id === tag?.sourceId)
    if (source?.type === 'thingsboard' && (!tag?.path || tag.path.length > 255)) error('tag.mapping', 'ThingsBoard tags require a telemetry key path.', `${path}.path`)
    if (tag?.freshnessMode != null && !TAG_FRESHNESS_MODES.includes(tag.freshnessMode)) error('tag.freshnessMode', 'freshnessMode must be periodic or event-driven.', `${path}.freshnessMode`)
    if (tag?.adaptiveFreshness != null && typeof tag.adaptiveFreshness !== 'boolean') error('tag.adaptiveFreshness', 'adaptiveFreshness must be a boolean.', `${path}.adaptiveFreshness`)
    if (tag?.staleAfterMs != null && (!Number.isInteger(tag.staleAfterMs) || tag.staleAfterMs < MIN_STALE_AFTER_MS || tag.staleAfterMs > MAX_STALE_AFTER_MS)) error('tag.staleAfter', 'staleAfterMs must be between 1 second and 24 hours.', `${path}.staleAfterMs`)
    if (tag?.dataType === 'number') {
      if (tag.numberFormat != null && !NUMERIC_FORMAT_MODES.includes(tag.numberFormat)) error('tag.numberFormat', 'Numeric Tag display must be normal number or percentage.', `${path}.numberFormat`)
      if (tag.numberFormat === 'percentage' && tag.engineering?.unit !== '%') error('tag.numberFormat.unit', 'Percentage Tags must use % as their engineering unit.', `${path}.engineering.unit`)
      if (tag.numberFormat === 'number' && String(tag.engineering?.unit || '').trim() === '%') error('tag.numberFormat.unit', 'Normal number Tags cannot use the reserved % unit; choose Percentage instead.', `${path}.engineering.unit`)
      if (!tag.engineering || typeof tag.engineering !== 'object' || Array.isArray(tag.engineering)) {
        warning('tag.engineering.missing', 'Numeric tag has no canonical engineering range and will use 0–100 defaults.', `${path}.engineering`)
      } else {
        const min = Number(tag.engineering.min)
        const max = Number(tag.engineering.max)
        const decimals = Number(tag.engineering.decimals)
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) error('tag.engineering.range', 'Numeric tag engineering maximum must be greater than minimum.', `${path}.engineering`)
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) error('tag.engineering.decimals', 'Numeric tag engineering decimals must be an integer between 0 and 8.', `${path}.engineering.decimals`)
        if (typeof tag.engineering.unit !== 'string' || tag.engineering.unit.length > 40) error('tag.engineering.unit', 'Numeric tag engineering unit must be text no longer than 40 characters.', `${path}.engineering.unit`)
      }
      if (tag.alarmRule != null) {
        const rule = tag.alarmRule
        if (!isPlainObject(rule)) {
          error('tag.alarmRule.invalid', 'Numeric Tag Alarm trigger must be an object or not configured.', `${path}.alarmRule`)
        } else if (!NUMERIC_ALARM_RULE_OPERATORS.includes(rule.operator)) {
          error('tag.alarmRule.operator', `Unsupported numeric Alarm operator: ${rule.operator ?? 'missing'}.`, `${path}.alarmRule.operator`)
        } else {
          const engineering = numericEngineering(tag)
          if (['between', 'outside'].includes(rule.operator)) {
            const min = strictFiniteNumber(rule.min)
            const max = strictFiniteNumber(rule.max)
            if (min == null || max == null || max < min) error('tag.alarmRule.range', 'Numeric Tag Alarm range requires finite minimum and maximum values in ascending order.', `${path}.alarmRule`)
            else if (hasNumericEngineering(tag) && (min < engineering.min || max > engineering.max)) error('tag.alarmRule.bounds', 'Numeric Tag Alarm range must stay inside the engineering range.', `${path}.alarmRule`)
          } else {
            const value = strictFiniteNumber(rule.value)
            if (value == null) error('tag.alarmRule.value', 'Numeric Tag Alarm trigger requires a finite comparison value.', `${path}.alarmRule.value`)
            else if (hasNumericEngineering(tag) && (value < engineering.min || value > engineering.max)) error('tag.alarmRule.bounds', 'Numeric Tag Alarm trigger value must stay inside the engineering range.', `${path}.alarmRule.value`)
          }
        }
      }
      if (tag.access !== 'read') {
        const limits = tag.writeConstraints
        if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
          warning('tag.writeConstraints.missing', 'Writable numeric tag has no canonical command limits and will use its engineering range.', `${path}.writeConstraints`)
        } else {
          const engineering = numericEngineering(tag)
          const min = Number(limits.min)
          const max = Number(limits.max)
          const step = Number(limits.step)
          if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || min < engineering.min || max > engineering.max) error('tag.writeConstraints.range', 'Numeric command limits must be ordered within the engineering range.', `${path}.writeConstraints`)
          if (!Number.isFinite(step) || step <= 0 || (Number.isFinite(max - min) && step > max - min)) error('tag.writeConstraints.step', 'Numeric command step must be positive and no larger than its command range.', `${path}.writeConstraints.step`)
        }
      }
    }
  })

  const components = Array.isArray(schema.components) ? schema.components : []
  if (!Array.isArray(schema.components)) error('components.invalid', 'Components must be an array.', 'components')
  const componentIds = new Map()
  components.forEach((component, index) => {
    const path = `components.${index}`
    if (!isPlainObject(component)) {
      error('component.invalid', 'Every component must be an object.', path)
      return
    }
    if (!boundedText(component.id, 200)) {
      error('component.id', 'Every component requires an id no longer than 200 characters.', `${path}.id`)
    } else if (componentIds.has(component.id)) {
      error('component.id', `Component id “${component.id}” is duplicated.`, `${path}.id`, { relatedPaths: [`components.${componentIds.get(component.id)}.id`] })
    } else componentIds.set(component.id, index)
    if (!boundedText(component.name, 160)) error('component.name', 'Every component requires a display name no longer than 160 characters.', `${path}.name`)
    if (!COMPONENT_TYPES.includes(component?.type)) {
      error('component.type', `Unsupported component type: ${component?.type ?? 'missing'}.`, `${path}.type`)
    }
    const position = component?.position
    for (const key of ['x', 'y', 'width', 'height', 'rotation']) {
      if (!Number.isFinite(position?.[key])) error('component.position', `${key} must be a finite number.`, `${path}.position.${key}`)
    }
    if (position?.width <= 0 || position?.height <= 0) {
      error('component.size', 'Component width and height must be greater than zero.', `${path}.position`)
    }
    if (component.zIndex != null && (!Number.isInteger(component.zIndex) || component.zIndex < 1 || component.zIndex > 1_000_000)) error('component.layer', 'Component layer must be an integer between 1 and 1,000,000.', `${path}.zIndex`)
    if (component.visible != null && typeof component.visible !== 'boolean') error('component.visible', 'Component visibility must be a boolean.', `${path}.visible`)
    if (component.locked != null && typeof component.locked !== 'boolean') error('component.locked', 'Component lock state must be a boolean.', `${path}.locked`)
    if (component.binding != null && !isPlainObject(component.binding)) error('binding.invalid', 'Component binding must be an object.', `${path}.binding`)
    if (!isPlainObject(component.properties)) error('component.properties', 'Component properties must be an object.', `${path}.properties`)
    if (canvas && Number.isFinite(position?.x) && Number.isFinite(position?.y) && (position.x < 0 || position.y < 0 || position.x + position.width > canvas.width || position.y + position.height > canvas.height)) {
      warning('component.bounds', `${component?.name || 'Component'} extends outside the logical canvas.`, `${path}.position`)
    }
    const tagId = component?.binding?.tagId
    const isChart = component?.type === 'chart'
    const requiresBinding = !['text-label', 'design-image', CONTROL_POPUP_TYPE].includes(component?.type) && !isChart
    if (!tagId) {
      if (requiresBinding) warning('binding.missing', `${component?.name || 'Component'} has no tag binding.`, `${path}.binding`)
    } else if (!tagIds.has(tagId)) error('binding.broken', `Binding references missing tag: ${tagId}.`, `${path}.binding.tagId`)

    if (tagId && tagIds.has(tagId)) {
      const tag = tags.find(item => item.id === tagId)
      const allowedTypes = COMPONENT_REGISTRY[component.type]?.allowedDataTypes || []
      if (tag && !allowedTypes.includes(tag.dataType)) {
        error('binding.type', `${component.name || component.type} cannot bind to ${tag.dataType} tag ${tagId}.`, `${path}.binding.tagId`)
      }
    }

    if (isChart) {
      const chartTagIds = component?.binding?.tagIds
      if (!Array.isArray(chartTagIds)) {
        error('chart.binding', 'Chart binding must contain a tagIds array.', `${path}.binding.tagIds`)
      } else {
        if (chartTagIds.length === 0) warning('binding.missing', `${component?.name || 'Chart'} has no tag bindings.`, `${path}.binding.tagIds`)
        if (chartTagIds.length > 8) error('chart.tags.limit', 'Chart can display at most 8 tags.', `${path}.binding.tagIds`)
        if (new Set(chartTagIds).size !== chartTagIds.length) error('chart.tags.duplicate', 'Chart tag bindings must be unique.', `${path}.binding.tagIds`)
        chartTagIds.forEach((chartTagId, chartTagIndex) => {
          const chartPath = `${path}.binding.tagIds.${chartTagIndex}`
          const chartTag = tags.find(item => item.id === chartTagId)
          if (!chartTag) error('binding.broken', `Binding references missing tag: ${chartTagId}.`, chartPath)
          else {
            if (chartTag.dataType !== 'number') error('binding.type', `${component.name || component.type} cannot chart ${chartTag.dataType} tag ${chartTagId}.`, chartPath)
            if (!['read', 'read-write'].includes(chartTag.access)) error('chart.tags.writeonly', `Chart cannot read write-only tag: ${chartTagId}.`, chartPath)
          }
        })
      }
      const historyLimit = Number(component.properties?.historyLimit ?? 300)
      const windowMinutes = Number(component.properties?.windowMinutes ?? 60)
      if (!Number.isInteger(historyLimit) || historyLimit < 30 || historyLimit > 2000) error('chart.historyLimit', 'Chart history limit must be an integer between 30 and 2000.', `${path}.properties.historyLimit`)
      if (!Number.isFinite(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) error('chart.windowMinutes', 'Chart time window must be between 1 and 1440 minutes.', `${path}.properties.windowMinutes`)
    }

    const rule = component?.properties?.rule
    if (rule && !isPlainObject(rule)) {
      error('rule.invalid', 'Component rule must be an object.', `${path}.properties.rule`)
    } else if (rule && !RULE_OPERATORS.includes(rule.operator)) {
      error('rule.operator', `Unsupported rule operator: ${rule.operator}.`, `${path}.properties.rule.operator`)
    } else if (rule && ['gt', 'gte', 'lt', 'lte'].includes(rule.operator) && !Number.isFinite(Number(rule.value))) {
      error('rule.value', `${rule.operator} rule requires a finite comparison value.`, `${path}.properties.rule.value`)
    } else if (['between', 'outside'].includes(rule?.operator) && (!Number.isFinite(Number(rule.min)) || !Number.isFinite(Number(rule.max)) || Number(rule.max) < Number(rule.min))) {
      error('rule.range', `${rule.operator === 'outside' ? 'Outside' : 'Between'} rule requires finite minimum and maximum values in ascending order.`, `${path}.properties.rule`)
    }

    if (component?.type === 'alarm') {
      const properties = component.properties || {}
      const presentation = properties.presentation ?? 'lamp'
      const frequencyHz = Number(properties.frequencyHz ?? 880)
      const volume = Number(properties.volume ?? 0.18)
      const pulseMs = Number(properties.pulseMs ?? 650)
      if (!ALARM_PRESENTATIONS.includes(presentation)) error('alarm.presentation', 'Alarm type must be Lamp or Buzzer.', `${path}.properties.presentation`)
      if (!ALARM_RULE_MODES.includes(properties.ruleMode ?? 'inherit')) error('alarm.ruleMode', 'Alarm trigger source must inherit from its Tag or use a custom component rule.', `${path}.properties.ruleMode`)
      if (properties.flash != null && typeof properties.flash !== 'boolean') error('alarm.flash', 'Alarm flash setting must be a boolean.', `${path}.properties.flash`)
      if (properties.soundEnabled != null && typeof properties.soundEnabled !== 'boolean') error('alarm.sound', 'Alarm sound setting must be a boolean.', `${path}.properties.soundEnabled`)
      if (!Number.isFinite(frequencyHz) || frequencyHz < ALARM_FREQUENCY_RANGE.min || frequencyHz > ALARM_FREQUENCY_RANGE.max) error('alarm.frequency', `Buzzer frequency must be between ${ALARM_FREQUENCY_RANGE.min} and ${ALARM_FREQUENCY_RANGE.max} Hz.`, `${path}.properties.frequencyHz`)
      if (!Number.isFinite(volume) || volume < ALARM_VOLUME_RANGE.min || volume > ALARM_VOLUME_RANGE.max) error('alarm.volume', 'Buzzer volume must be between 0 and 0.5.', `${path}.properties.volume`)
      if (!Number.isInteger(pulseMs) || pulseMs < ALARM_PULSE_RANGE.min || pulseMs > ALARM_PULSE_RANGE.max) error('alarm.pulse', `Buzzer pulse interval must be an integer between ${ALARM_PULSE_RANGE.min} and ${ALARM_PULSE_RANGE.max} ms.`, `${path}.properties.pulseMs`)
      for (const key of ['activeColor', 'idleColor']) {
        if (properties[key] != null && (typeof properties[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(properties[key]))) error('alarm.color', 'Alarm colors must use six-digit hexadecimal values.', `${path}.properties.${key}`)
      }
    }

    if (COMMAND_COMPONENT_TYPES.has(component?.type) && tagId) {
      const tag = tags.find(item => item.id === tagId)
      if (tag && !['write', 'read-write'].includes(tag.access)) {
        error('binding.readonly', `Command component is bound to read-only tag: ${tagId}.`, `${path}.binding.tagId`)
      }
      const commandSource = sources.find(source => source.id === tag?.sourceId)
      if (profile === 'real' && commandSource?.type === 'mock') {
        error('command.profileSource', `REAL PLC control ${component.name || component.id} must bind to a live connector tag.`, `${path}.binding.tagId`)
      }
      const feedbackTagId = component.properties?.feedbackTagId
      const feedback = feedbackTagId ? tags.find(item => item.id === feedbackTagId) : null
      if (feedbackTagId && !feedback) error('command.feedback', `Feedback references missing tag: ${feedbackTagId}.`, `${path}.properties.feedbackTagId`)
      if (feedback?.access === 'write') error('command.feedback.readable', `Feedback tag ${feedbackTagId} is write-only and cannot acknowledge a command.`, `${path}.properties.feedbackTagId`)
      if (component.type === 'tuning-slider' && feedback && feedback.dataType !== 'number') error('command.feedback.type', 'Tuning Slider feedback must use a numeric tag.', `${path}.properties.feedbackTagId`)
      if (component.type === 'control-button' && tag && feedback && feedback.dataType !== tag.dataType && component.properties?.expectedFeedbackValue == null) error('command.feedback.type', `Control feedback type ${feedback.dataType} does not match command type ${tag.dataType}; configure an explicit expected feedback value or choose a matching tag.`, `${path}.properties.feedbackTagId`)
      const feedbackSource = sources.find(source => source.id === feedback?.sourceId)
      if (profile === 'real' && feedbackSource?.type === 'mock') error('command.feedback.source', 'REAL PLC command feedback must use a live connector tag.', `${path}.properties.feedbackTagId`)
      const ackTimeoutMs = Number(component.properties?.ackTimeoutMs ?? 5000)
      if (!Number.isInteger(ackTimeoutMs) || ackTimeoutMs < 1000 || ackTimeoutMs > 30000) error('command.timeout', 'Command acknowledgment timeout must be between 1 and 30 seconds.', `${path}.properties.ackTimeoutMs`)
      if (component.properties?.rpcMethod && !/^[a-zA-Z0-9_.:-]{1,100}$/.test(component.properties.rpcMethod)) error('command.rpcMethod', 'RPC method contains unsupported characters.', `${path}.properties.rpcMethod`)
      if (!COMMAND_CONFIRMATIONS.has(component.properties?.confirmation || 'single')) error('command.confirmation', 'Command confirmation must be none or single.', `${path}.properties.confirmation`)
      if (!COMMAND_ROLES.has(component.properties?.requiredRole || 'OPERATOR')) error('command.role', 'Command role must be VIEWER, EDITOR, OPERATOR, ADMIN, or OWNER.', `${path}.properties.requiredRole`)
    }

    if (component?.type === 'control-button') {
      const tag = tags.find(item => item.id === tagId)
      const action = component.properties?.action || 'toggle-boolean'
      if (!CONTROL_ACTIONS.has(action)) error('button.action', `Unsupported Control Button action: ${action}.`, `${path}.properties.action`)
      if (['toggle-boolean', 'pulse'].includes(action) && tag && tag.dataType !== 'boolean') error('button.action.type', `${action} requires a boolean command tag.`, `${path}.properties.action`)
      if (action === 'set-value' && tag?.dataType === 'number' && !Number.isFinite(Number(component.properties?.payload))) error('button.payload', 'Numeric Set value payload must be a finite number.', `${path}.properties.payload`)
      const pulseMs = Number(component.properties?.pulseMs ?? 300)
      if (action === 'pulse' && (!Number.isInteger(pulseMs) || pulseMs < 50 || pulseMs > 60_000)) error('button.pulse', 'Pulse duration must be an integer between 50 and 60,000 ms.', `${path}.properties.pulseMs`)
      const cooldownMs = Number(component.properties?.cooldownMs ?? 800)
      if (!Number.isInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 60_000) error('button.cooldown', 'Button cooldown must be an integer between 0 and 60,000 ms.', `${path}.properties.cooldownMs`)
    }

    if (component?.type === 'tuning-slider') {
      const tag = tags.find(item => item.id === tagId)
      const range = resolveNumericRange(tag, component.properties, 'write')
      const min = Number(range.min)
      const max = Number(range.max)
      const step = Number(range.step)
      const decimals = Number(component.properties?.decimals ?? 0)
      const simulationRampPerSecond = Number(component.properties?.simulationRampPerSecond ?? Math.abs(max - min) * .001)
      if (!NUMERIC_RANGE_MODES.includes(component.properties?.rangeMode ?? 'custom')) error('tuning.rangeMode', 'Tuning Slider range mode must inherit from its tag or use a custom range.', `${path}.properties.rangeMode`)
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) error('tuning.range', 'Tuning Slider maximum must be greater than minimum.', `${path}.properties`)
      if (!Number.isFinite(step) || step <= 0 || (Number.isFinite(max - min) && step > max - min)) error('tuning.step', 'Tuning Slider step must be positive and no larger than its range.', `${path}.properties.step`)
      if (!hasNumericEngineering(tag)) {
        const configuredMin = Number(component.properties?.min)
        const configuredMax = Number(component.properties?.max)
        const configuredStep = Number(component.properties?.step)
        if (!Number.isFinite(configuredMin) || !Number.isFinite(configuredMax) || configuredMax <= configuredMin) error('tuning.range', 'Tuning Slider maximum must be greater than minimum.', `${path}.properties`)
        if (!Number.isFinite(configuredStep) || configuredStep <= 0 || configuredStep > configuredMax - configuredMin) error('tuning.step', 'Tuning Slider step must be positive and no larger than its range.', `${path}.properties.step`)
      }
      if (component.properties?.rangeMode === 'custom' && hasNumericEngineering(tag)) {
        const limits = numericWriteConstraints(tag)
        const customMin = Number(component.properties?.min)
        const customMax = Number(component.properties?.max)
        const customStep = Number(component.properties?.step)
        if (!Number.isFinite(customMin) || !Number.isFinite(customMax) || customMax <= customMin || customMin < limits.min || customMax > limits.max) error('tuning.overrideRange', 'Custom Slider range may only narrow the Tag command limits.', `${path}.properties`)
        if (!Number.isFinite(customStep) || customStep < limits.step || Math.abs(customStep / limits.step - Math.round(customStep / limits.step)) > 1e-7) error('tuning.overrideStep', 'Custom Slider step must be a whole multiple of the Tag command step.', `${path}.properties.step`)
      }
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) error('tuning.decimals', 'Tuning Slider decimals must be an integer between 0 and 8.', `${path}.properties.decimals`)
      if (!Number.isFinite(simulationRampPerSecond) || simulationRampPerSecond <= 0 || simulationRampPerSecond > 1_000_000) error('tuning.simulationRamp', 'Simulation ramp rate must be greater than zero and no more than 1,000,000 units per second.', `${path}.properties.simulationRampPerSecond`)
    }

    if (component?.type === 'gauge') {
      const tag = tags.find(item => item.id === tagId)
      const range = resolveNumericRange(tag, component.properties, 'display')
      const min = Number(range.min)
      const max = Number(range.max)
      const zones = component.properties?.rangeMode === 'inherit' ? resolveGaugeZones(range, component.properties) : component.properties
      const lowZoneEnd = Number(zones?.lowZoneEnd ?? min + (max - min) * .3)
      const highZoneStart = Number(zones?.highZoneStart ?? min + (max - min) * .7)
      const decimals = Number(component.properties?.decimals ?? 1)
      const tickCount = Number(component.properties?.tickCount ?? 10)
      if (!NUMERIC_RANGE_MODES.includes(component.properties?.rangeMode ?? 'custom')) error('gauge.rangeMode', 'Gauge range mode must inherit from its tag or use a custom range.', `${path}.properties.rangeMode`)
      if (!['inherit', 'custom'].includes(component.properties?.unitMode ?? 'inherit')) error('gauge.unitMode', 'Gauge unit must inherit from its Tag or use a custom value.', `${path}.properties.unitMode`)
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) error('gauge.range', 'Gauge maximum must be greater than minimum.', `${path}.properties`)
      if (!hasNumericEngineering(tag)) {
        const configuredMin = Number(component.properties?.min)
        const configuredMax = Number(component.properties?.max)
        if (!Number.isFinite(configuredMin) || !Number.isFinite(configuredMax) || configuredMax <= configuredMin) error('gauge.range', 'Gauge maximum must be greater than minimum.', `${path}.properties`)
      }
      if (!Number.isFinite(lowZoneEnd) || !Number.isFinite(highZoneStart) || lowZoneEnd < min || highZoneStart > max || lowZoneEnd > highZoneStart) error('gauge.zones', 'Gauge color zones must be ordered within its minimum and maximum.', `${path}.properties`)
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) error('gauge.decimals', 'Gauge decimals must be an integer between 0 and 8.', `${path}.properties.decimals`)
      if (!Number.isInteger(tickCount) || tickCount < 4 || tickCount > 12) error('gauge.ticks', 'Gauge tick count must be an integer between 4 and 12.', `${path}.properties.tickCount`)
      if (!Number.isFinite(Number(component.properties?.scale ?? 1))) error('gauge.scale', 'Gauge scale must be a finite number.', `${path}.properties.scale`)
      if (!Number.isFinite(Number(component.properties?.offset ?? 0))) error('gauge.offset', 'Gauge offset must be a finite number.', `${path}.properties.offset`)
    }

    if (component?.type === 'operation-shifter') {
      const controlledIds = component.properties?.controlledComponentIds
      const sequence = component.properties?.autoSequence
      if (!Array.isArray(controlledIds) || controlledIds.length > 64 || new Set(controlledIds).size !== controlledIds.length) error('operation.controls', 'Operation Shifter requires up to 64 unique supervised control IDs.', `${path}.properties.controlledComponentIds`)
      for (const controlledId of Array.isArray(controlledIds) ? controlledIds : []) {
        const controlled = components.find(item => item.id === controlledId)
        if (!controlled || !['control-button', 'tuning-slider'].includes(controlled.type)) error('operation.control', `Operation Shifter references an invalid control: ${controlledId}.`, `${path}.properties.controlledComponentIds`)
      }
      if (!Array.isArray(sequence) || sequence.length > 32) error('operation.sequence', 'Operation sequence must contain no more than 32 steps.', `${path}.properties.autoSequence`)
      const stepIds = new Set()
      for (const [stepIndex, step] of (Array.isArray(sequence) ? sequence : []).entries()) {
        const stepPath = `${path}.properties.autoSequence.${stepIndex}`
        if (!step?.id || stepIds.has(step.id)) error('operation.stepId', 'Every operation sequence step requires a unique ID.', `${stepPath}.id`)
        else stepIds.add(step.id)
        const target = components.find(item => item.id === step?.componentId)
        if (!target || target.type !== 'control-button') error('operation.stepControl', 'AUTO sequence steps must reference Control Button components.', `${stepPath}.componentId`)
        if (Array.isArray(controlledIds) && !controlledIds.includes(step?.componentId)) error('operation.stepSupervision', 'AUTO sequence controls must also be supervised by the Operation Shifter.', `${stepPath}.componentId`)
        if (typeof step?.value !== 'boolean') error('operation.stepValue', 'AUTO sequence step value must be ACTIVE or INACTIVE.', `${stepPath}.value`)
        if (!Number.isInteger(step?.delayMs) || step.delayMs < 0 || step.delayMs > 3_600_000) error('operation.stepDelay', 'AUTO sequence delay must be between 0 and 3,600,000 ms.', `${stepPath}.delayMs`)
      }
      if (!component.properties?.rpcMethod) error('operation.rpcMethod', 'Operation Shifter requires an RPC method.', `${path}.properties.rpcMethod`)
      const feedback = component.properties?.feedbackTagId && tags.find(item => item.id === component.properties.feedbackTagId)
      if (feedback && (!['string', 'enum'].includes(feedback.dataType) || feedback.access === 'write')) error('operation.feedback', 'Operation mode feedback must be a readable string or enum tag.', `${path}.properties.feedbackTagId`)
    }

    if (component?.type === 'value-span') {
      const decimals = Number(component.properties?.decimals ?? 1)
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
        error('value.decimals', 'Value Span decimals must be an integer between 0 and 8.', `${path}.properties.decimals`)
      }
      if (!Number.isFinite(Number(component.properties?.scale ?? 1))) error('value.scale', 'Value Span scale must be a finite number.', `${path}.properties.scale`)
      if (!Number.isFinite(Number(component.properties?.offset ?? 0))) error('value.offset', 'Value Span offset must be a finite number.', `${path}.properties.offset`)
      validateOptionalThreshold(component.properties, 'warningHigh', path, error)
      validateOptionalThreshold(component.properties, 'criticalHigh', path, error)
      validateOptionalThreshold(component.properties, 'warningLow', path, error)
      validateOptionalThreshold(component.properties, 'criticalLow', path, error)
      const warningHigh = optionalFinite(component.properties?.warningHigh)
      const criticalHigh = optionalFinite(component.properties?.criticalHigh)
      const warningLow = optionalFinite(component.properties?.warningLow)
      const criticalLow = optionalFinite(component.properties?.criticalLow)
      if (warningHigh != null && criticalHigh != null && criticalHigh < warningHigh) error('value.thresholds.high', 'Critical high threshold must be greater than or equal to warning high.', `${path}.properties.criticalHigh`)
      if (warningLow != null && criticalLow != null && criticalLow > warningLow) error('value.thresholds.low', 'Critical low threshold must be less than or equal to warning low.', `${path}.properties.criticalLow`)
    }

    if (component?.type === 'text-label') {
      const fontSize = Number(component.properties?.fontSize ?? 32)
      if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 300) {
        error('text.fontSize', 'Text font size must be between 6 and 300.', `${path}.properties.fontSize`)
      }
      if (!['left', 'center', 'right'].includes(component.properties?.textAlign || 'left')) {
        error('text.align', 'Text alignment must be left, center, or right.', `${path}.properties.textAlign`)
      }
      if (!['top', 'middle', 'bottom'].includes(component.properties?.verticalAlign || 'middle')) error('text.verticalAlign', 'Vertical text alignment must be top, middle, or bottom.', `${path}.properties.verticalAlign`)
      if (![400, 600, 700, 900].includes(Number(component.properties?.fontWeight ?? 700))) error('text.weight', 'Text weight must be 400, 600, 700, or 900.', `${path}.properties.fontWeight`)
      if (!['normal', 'italic'].includes(component.properties?.fontStyle || 'normal')) error('text.style', 'Text style must be normal or italic.', `${path}.properties.fontStyle`)
      if (!['sans-serif', 'serif', 'monospace'].includes(component.properties?.fontFamily || 'sans-serif')) error('text.family', 'Text font family must be sans-serif, serif, or monospace.', `${path}.properties.fontFamily`)
    }

    if (component?.type === 'design-image') {
      if (!component.properties?.assetId || typeof component.properties.assetId !== 'string' || component.properties.assetId.length > 200) {
        error('designImage.asset', 'Custom Image requires a valid uploaded asset.', `${path}.properties.assetId`)
      }
      if (!['contain', 'cover', 'fill'].includes(component.properties?.objectFit || 'contain')) {
        error('designImage.fit', 'Custom Image fit must be contain, cover, or fill.', `${path}.properties.objectFit`)
      }
      if (component.properties?.lockAspectRatio != null && typeof component.properties.lockAspectRatio !== 'boolean') {
        error('designImage.aspect', 'Custom Image aspect ratio lock must be a boolean.', `${path}.properties.lockAspectRatio`)
      }
      const opacity = Number(component.properties?.opacity ?? 1)
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
        error('designImage.opacity', 'Custom Image opacity must be between 0 and 1.', `${path}.properties.opacity`)
      }
    }
  })

  const popupOwners = new Map()
  components.forEach((popup, popupIndex) => {
    if (popup?.type !== CONTROL_POPUP_TYPE) return
    const path = `components.${popupIndex}`
    if (!Array.isArray(popup.children)) {
      error('popup.children', 'Control Pop-up children must be an array of component IDs.', `${path}.children`)
      return
    }
    if (popup.children.length > CONTROL_POPUP_MAX_CHILDREN) error('popup.children.limit', `Control Pop-up can contain at most ${CONTROL_POPUP_MAX_CHILDREN} controls.`, `${path}.children`)
    if (new Set(popup.children).size !== popup.children.length) error('popup.children.duplicate', 'Control Pop-up child references must be unique.', `${path}.children`)
    popup.children.forEach((childId, childIndex) => {
      const childPath = `${path}.children.${childIndex}`
      const child = components.find(component => component.id === childId)
      if (!child) error('popup.child.missing', `Control Pop-up references missing component: ${childId}.`, childPath)
      else if (!CONTROL_POPUP_CHILD_TYPES.has(child.type)) error('popup.child.type', `Control Pop-up cannot contain ${child.type}.`, childPath)
      const owner = popupOwners.get(childId)
      if (owner && owner !== popup.id) error('popup.child.owner', `Control ${childId} belongs to more than one Control Pop-up.`, childPath)
      else popupOwners.set(childId, popup.id)
    })
    const columns = Number(popup.properties?.columns ?? 2)
    const dialogWidth = Number(popup.properties?.dialogWidth ?? 720)
    if (!Number.isInteger(columns) || columns < 1 || columns > 3) error('popup.columns', 'Control Pop-up columns must be an integer between 1 and 3.', `${path}.properties.columns`)
    if (!Number.isInteger(dialogWidth) || dialogWidth < 360 || dialogWidth > 1200) error('popup.width', 'Control Pop-up dialog width must be between 360 and 1200 pixels.', `${path}.properties.dialogWidth`)
    if (popup.properties?.closeOnBackdrop != null && typeof popup.properties.closeOnBackdrop !== 'boolean') error('popup.backdrop', 'Control Pop-up closeOnBackdrop must be a boolean.', `${path}.properties.closeOnBackdrop`)
  })

  const rpcMethods = new Map()
  components.forEach((component, componentIndex) => {
    if (!COMMAND_COMPONENT_TYPES.has(component?.type)) return
    const rpcMethod = String(component.properties?.rpcMethod || '').trim()
    if (!rpcMethod) return
    const path = `components.${componentIndex}.properties.rpcMethod`
    if (rpcMethods.has(rpcMethod)) error('command.rpcMethod.duplicate', `RPC method “${rpcMethod}” is assigned to more than one command component.`, path, { relatedPaths: [rpcMethods.get(rpcMethod)] })
    else rpcMethods.set(rpcMethod, path)
  })

  for (const secretPath of secretLikePaths(schema)) {
    error('schema.secret', 'Project schema must not contain connector credentials or secrets.', secretPath, { redacted: true })
  }
  return issues
}

export function migrateProjectSchema(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const schema = structuredClone(input)
  if (schema.schemaVersion === PROJECT_SCHEMA_VERSION) {
    schema.project = { ...schema.project, runtimeProfile: runtimeProfile(schema) }
    if (Array.isArray(schema.tags)) schema.tags = schema.tags.map(normalizeTagFreshness)
    if (Array.isArray(schema.components)) schema.components = schema.components.map(normalizeOperationShifterGeometry)
    migrateNumericConfiguration(schema, { legacy: false })
    return schema
  }
  if (!LEGACY_PROJECT_SCHEMA_VERSIONS.includes(schema.schemaVersion)) return schema
  const sourceVersion = schema.schemaVersion
  if (schema.schemaVersion === '1.0.0') {
    schema.dataSources = (Array.isArray(schema.dataSources) ? schema.dataSources : []).map(source => ({
      ...source,
      environmentRef: source.environmentRef || (source.type === 'mock' ? 'development' : 'staging'),
      connectorRef: source.type === 'mock' ? null : (source.connectorRef || null),
    }))
  }
  if (Array.isArray(schema.tags)) schema.tags = schema.tags.map(normalizeTagFreshness)
  if (Array.isArray(schema.components)) {
    schema.components = schema.components.map(normalizeOperationShifterGeometry).map(component => {
      if (component?.type !== 'tuning-slider') return component
      const properties = { ...component.properties }
      if (properties.simulationRampPerSecond == null || (sourceVersion === '1.4.0' && properties.simulationRampPerSecond === 5)) {
        const min = Number(properties.min ?? 0)
        const max = Number(properties.max ?? 100)
        properties.simulationRampPerSecond = Math.max(.001, Math.abs(max - min) * .001)
      }
      return { ...component, properties }
    })
  }
  migrateNumericConfiguration(schema, { legacy: true })
  schema.project = { ...schema.project, runtimeProfile: runtimeProfile(schema) }
  schema.schemaVersion = PROJECT_SCHEMA_VERSION
  return schema
}

function migrateNumericConfiguration(schema, { legacy }) {
  const tags = Array.isArray(schema.tags) ? schema.tags : []
  const components = Array.isArray(schema.components) ? schema.components : []
  const byTagId = new Map()
  for (const component of components) {
    const tagId = component?.binding?.tagId
    if (!tagId) continue
    if (!byTagId.has(tagId)) byTagId.set(tagId, [])
    byTagId.get(tagId).push(component)
  }

  schema.tags = tags.map(tag => {
    if (tag?.dataType !== 'number') return tag
    const bound = byTagId.get(tag.id) || []
    const displaySource = bound.find(component => component.type === 'gauge' && validRange(component.properties))
      || bound.find(component => component.type === 'tuning-slider' && validRange(component.properties))
    const writeSource = bound.find(component => component.type === 'tuning-slider' && validRange(component.properties))
    const formatSource = bound.find(component => ['gauge', 'value-span', 'tuning-slider'].includes(component.type))
    const engineering = {
      min: displaySource ? Number(displaySource.properties.min) : 0,
      max: displaySource ? Number(displaySource.properties.max) : 100,
      unit: String(formatSource?.properties?.suffix || ''),
      decimals: boundedDecimals(formatSource?.properties?.decimals),
    }
    const writeConstraints = writeSource
      ? { min: Number(writeSource.properties.min), max: Number(writeSource.properties.max), step: positiveNumber(writeSource.properties.step, 1) }
      : undefined
    if (!legacy && tag.engineering && typeof tag.engineering === 'object' && !Array.isArray(tag.engineering)) return tag
    return normalizeNumericTagConfiguration(tag, { engineering, writeConstraints })
  })

  const tagById = new Map(schema.tags.map(tag => [tag.id, tag]))
  schema.components = components.map(component => {
    if (!['gauge', 'tuning-slider'].includes(component?.type) || component.properties?.rangeMode) return component
    const properties = { ...component.properties }
    const tag = tagById.get(component.binding?.tagId)
    if (!tag) properties.rangeMode = validRange(properties) ? 'custom' : 'inherit'
    else {
      const inherited = component.type === 'tuning-slider' ? numericWriteConstraints(tag) : numericEngineering(tag)
      properties.rangeMode = validRange(properties) && !sameRange(properties, inherited) ? 'custom' : 'inherit'
    }
    if (component.type === 'gauge') {
      const range = resolveNumericRange(tag, properties, 'display')
      const lowZoneEnd = Number(properties.lowZoneEnd)
      const highZoneStart = Number(properties.highZoneStart)
      if (!Number.isFinite(lowZoneEnd) || !Number.isFinite(highZoneStart) || lowZoneEnd < range.min || highZoneStart > range.max || lowZoneEnd > highZoneStart) {
        properties.lowZoneEnd = range.min + (range.max - range.min) * .3
        properties.highZoneStart = range.min + (range.max - range.min) * .7
      }
    }
    return { ...component, properties }
  })
}

function validRange(properties) {
  const min = Number(properties?.min)
  const max = Number(properties?.max)
  return Number.isFinite(min) && Number.isFinite(max) && max > min
}

function sameRange(left, right) {
  return Math.abs(Number(left?.min) - Number(right?.min)) < 1e-9 && Math.abs(Number(left?.max) - Number(right?.max)) < 1e-9
}

function boundedDecimals(value) {
  const number = Number(value)
  return Number.isInteger(number) ? Math.max(0, Math.min(8, number)) : 1
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function normalizeOperationShifterGeometry(component) {
  if (component?.type !== 'operation-shifter') return component
  const position = component.position || {}
  if (Number(position.width) !== 420 || Number(position.height) !== 210) return component
  return { ...component, position: { ...position, width: 220, height: 72 } }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
}

function optionalFinite(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function strictFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function validateOptionalThreshold(properties, key, componentPath, error) {
  const value = properties?.[key]
  if (value === null || value === undefined || value === '') return
  if (!Number.isFinite(Number(value))) error('value.threshold', `${key} threshold must be a finite number or empty.`, `${componentPath}.properties.${key}`)
}

function secretLikePaths(value, path = '', seen = new WeakSet(), results = []) {
  if (!value || typeof value !== 'object' || results.length >= 20 || seen.has(value)) return results
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((child, index) => secretLikePaths(child, path ? `${path}.${index}` : String(index), seen, results))
    return results
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    if (/^(password|secret|token|apiKey|accessKey|privateKey|credential|connectionString|authorization)$/i.test(key)) results.push(childPath)
    else secretLikePaths(child, childPath, seen, results)
    if (results.length >= 20) break
  }
  return results
}

export function hasBlockingIssues(issues) {
  return Array.isArray(issues) && issues.some(issue => issue?.severity === 'error')
}
