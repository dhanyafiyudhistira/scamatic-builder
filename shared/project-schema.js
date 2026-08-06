import { COMPONENT_REGISTRY } from './component-registry.js'
import { RULE_OPERATORS } from './runtime-evaluator.js'
import { CONTROL_POPUP_CHILD_TYPES, CONTROL_POPUP_MAX_CHILDREN, CONTROL_POPUP_TYPE } from './control-popup.js'
import { MAX_STALE_AFTER_MS, MIN_STALE_AFTER_MS, normalizeTagFreshness, TAG_FRESHNESS_MODES } from './tag-freshness.js'
import { RUNTIME_PROFILES, runtimeProfile } from './runtime-profile.js'

export const PROJECT_SCHEMA_VERSION = '1.5.0'
export const LEGACY_PROJECT_SCHEMA_VERSIONS = Object.freeze(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0'])
export const COMPONENT_TYPES = Object.keys(COMPONENT_REGISTRY)

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
  const error = (code, message, path = '') => issues.push({ severity: 'error', code, message, path })
  const warning = (code, message, path = '') => issues.push({ severity: 'warning', code, message, path })

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    error('schema.invalid', 'Project schema must be an object.')
    return issues
  }
  if (schema.schemaVersion !== PROJECT_SCHEMA_VERSION && !LEGACY_PROJECT_SCHEMA_VERSIONS.includes(schema.schemaVersion)) {
    error('schema.version', `Unsupported schema version: ${schema.schemaVersion ?? 'missing'}.`, 'schemaVersion')
  }
  if (!schema.project?.id || !schema.project?.name || !schema.project?.slug) {
    error('project.identity', 'Project id, name, and slug are required.', 'project')
  }
  if (!RUNTIME_PROFILES.includes(schema.project?.runtimeProfile)) {
    error('project.runtimeProfile', 'Runtime profile must be simulation, real, or monitor.', 'project.runtimeProfile')
  }

  const canvas = schema.project?.canvas
  if (!canvas || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width < 320 || canvas.height < 240) {
    error('canvas.invalid', 'Canvas dimensions must be finite and at least 320 × 240.', 'project.canvas')
  }
  if (requireAsset && !schema.project?.svgAssetId) {
    error('asset.missing', 'A sanitized SVG asset is required before publish.', 'project.svgAssetId')
  }

  const tags = Array.isArray(schema.tags) ? schema.tags : []
  if (!Array.isArray(schema.tags)) error('tags.invalid', 'Tags must be an array.', 'tags')
  const tagIds = new Set()
  const tagPaths = new Set()
  const sources = Array.isArray(schema.dataSources) ? schema.dataSources : []
  const sourceIds = new Set()
  if (!Array.isArray(schema.dataSources)) error('sources.invalid', 'Data sources must be an array.', 'dataSources')
  sources.forEach((source, index) => {
    const path = `dataSources.${index}`
    if (!source?.id || sourceIds.has(source.id)) error('source.id', 'Every data source must have a unique id.', `${path}.id`)
    else sourceIds.add(source.id)
    if (!['mock', 'thingsboard'].includes(source?.type)) error('source.type', `Unsupported data source type: ${source?.type ?? 'missing'}.`, `${path}.type`)
    if (!['development', 'staging', 'production'].includes(source?.environmentRef || 'development')) error('source.environment', 'Invalid connector environment.', `${path}.environmentRef`)
    if (source?.type !== 'mock' && !source?.connectorRef) error('source.connector', 'Non-mock data sources require connectorRef.', `${path}.connectorRef`)
  })
  const profile = runtimeProfile(schema)
  if (['real', 'monitor'].includes(profile) && !sources.some(source => source?.type && source.type !== 'mock')) {
    error('profile.liveSource', `${profile === 'real' ? 'REAL PLC' : 'MONITOR ONLY'} requires at least one live data source.`, 'dataSources')
  }
  tags.forEach((tag, index) => {
    const path = `tags.${index}`
    if (!tag?.id || tagIds.has(tag.id)) error('tag.id', 'Every tag must have a unique id.', `${path}.id`)
    else tagIds.add(tag.id)
    if (!tag?.path || tagPaths.has(tag.path)) error('tag.path', 'Every tag must have a unique path.', `${path}.path`)
    else tagPaths.add(tag.path)
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
  })

  const components = Array.isArray(schema.components) ? schema.components : []
  if (!Array.isArray(schema.components)) error('components.invalid', 'Components must be an array.', 'components')
  const componentIds = new Set()
  components.forEach((component, index) => {
    const path = `components.${index}`
    if (!component?.id || componentIds.has(component.id)) {
      error('component.id', 'Every component must have a unique id.', `${path}.id`)
    } else componentIds.add(component.id)
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
    if (rule && !RULE_OPERATORS.includes(rule.operator)) {
      error('rule.operator', `Unsupported rule operator: ${rule.operator}.`, `${path}.properties.rule`)
    }

    if (['control-button', 'tuning-slider', 'operation-shifter'].includes(component?.type) && tagId) {
      const tag = tags.find(item => item.id === tagId)
      if (tag && !['write', 'read-write'].includes(tag.access)) {
        error('binding.readonly', `Command component is bound to read-only tag: ${tagId}.`, `${path}.binding.tagId`)
      }
      const commandSource = sources.find(source => source.id === tag?.sourceId)
      if (profile === 'real' && commandSource?.type === 'mock') {
        error('command.profileSource', `REAL PLC control ${component.name || component.id} must bind to a live connector tag.`, `${path}.binding.tagId`)
      }
      const feedbackTagId = component.properties?.feedbackTagId
      if (feedbackTagId && !tagIds.has(feedbackTagId)) error('command.feedback', `Feedback references missing tag: ${feedbackTagId}.`, `${path}.properties.feedbackTagId`)
      const ackTimeoutMs = Number(component.properties?.ackTimeoutMs ?? 5000)
      if (!Number.isInteger(ackTimeoutMs) || ackTimeoutMs < 1000 || ackTimeoutMs > 30000) error('command.timeout', 'Command acknowledgment timeout must be between 1 and 30 seconds.', `${path}.properties.ackTimeoutMs`)
      if (component.properties?.rpcMethod && !/^[a-zA-Z0-9_.:-]{1,100}$/.test(component.properties.rpcMethod)) error('command.rpcMethod', 'RPC method contains unsupported characters.', `${path}.properties.rpcMethod`)
    }

    if (component?.type === 'tuning-slider') {
      const min = Number(component.properties?.min ?? 0)
      const max = Number(component.properties?.max ?? 100)
      const step = Number(component.properties?.step ?? 1)
      const decimals = Number(component.properties?.decimals ?? 0)
      const simulationRampPerSecond = Number(component.properties?.simulationRampPerSecond ?? Math.abs(max - min) * .001)
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) error('tuning.range', 'Tuning Slider maximum must be greater than minimum.', `${path}.properties`)
      if (!Number.isFinite(step) || step <= 0 || (Number.isFinite(max - min) && step > max - min)) error('tuning.step', 'Tuning Slider step must be positive and no larger than its range.', `${path}.properties.step`)
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) error('tuning.decimals', 'Tuning Slider decimals must be an integer between 0 and 8.', `${path}.properties.decimals`)
      if (!Number.isFinite(simulationRampPerSecond) || simulationRampPerSecond <= 0 || simulationRampPerSecond > 1_000_000) error('tuning.simulationRamp', 'Simulation ramp rate must be greater than zero and no more than 1,000,000 units per second.', `${path}.properties.simulationRampPerSecond`)
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
    }

    if (component?.type === 'text-label') {
      const fontSize = Number(component.properties?.fontSize ?? 32)
      if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 300) {
        error('text.fontSize', 'Text font size must be between 6 and 300.', `${path}.properties.fontSize`)
      }
      if (!['left', 'center', 'right'].includes(component.properties?.textAlign || 'left')) {
        error('text.align', 'Text alignment must be left, center, or right.', `${path}.properties.textAlign`)
      }
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
  })

  if (containsSecretLikeKey(schema)) {
    error('schema.secret', 'Project schema must not contain connector credentials or secrets.')
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
  schema.project = { ...schema.project, runtimeProfile: runtimeProfile(schema) }
  schema.schemaVersion = PROJECT_SCHEMA_VERSION
  return schema
}

function normalizeOperationShifterGeometry(component) {
  if (component?.type !== 'operation-shifter') return component
  const position = component.position || {}
  if (Number(position.width) !== 420 || Number(position.height) !== 210) return component
  return { ...component, position: { ...position, width: 220, height: 72 } }
}

function containsSecretLikeKey(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSecretLikeKey)
  return Object.entries(value).some(([key, child]) => {
    if (/^(password|secret|token|apiKey|accessKey|privateKey|credential|connectionString|authorization)$/i.test(key)) return true
    return containsSecretLikeKey(child)
  })
}

export function hasBlockingIssues(issues) {
  return issues.some(issue => issue.severity === 'error')
}
