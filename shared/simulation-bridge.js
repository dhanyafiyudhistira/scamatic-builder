import { coerceConnectorValue } from './connector-contract.js'
import { evaluateOperationShift, initialMockValue } from './runtime-evaluator.js'

export function simulationTelemetryPayload(schema, values, { allowEmpty = false } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Simulation values must be an object.')
  const tags = Array.isArray(schema?.tags) ? schema.tags : []
  const knownIds = new Set(tags.map(tag => tag.id))
  const unknown = Object.keys(values).find(tagId => !knownIds.has(tagId))
  if (unknown) throw new TypeError(`Simulation contains an unknown tag: ${unknown}.`)
  const payload = {}
  for (const tag of tags) {
    if (!tag?.path || !['read', 'read-write'].includes(tag.access) || values[tag.id] == null) continue
    payload[tag.path] = coerceConnectorValue(values[tag.id], tag.dataType)
  }
  if (!allowEmpty && !Object.keys(payload).length) throw new TypeError('Simulation has no readable telemetry values to publish.')
  return payload
}

export function simulationTelemetryDelta(schema, values, publishedValues = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Simulation values must be an object.')
  const delta = {}
  for (const tag of Array.isArray(schema?.tags) ? schema.tags : []) {
    if (!tag?.path || !['read', 'read-write'].includes(tag.access) || values[tag.id] == null) continue
    if (!Object.is(values[tag.id], publishedValues[tag.id])) delta[tag.id] = values[tag.id]
  }
  return delta
}

// A runtime reload is a read/hydration event, never an operator command. Seed the
// publisher with the values rendered during bootstrap so synthetic defaults are
// not mistaken for fresh telemetry and pushed upstream.
export function simulationTelemetryBaseline(schema, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Simulation values must be an object.')
  const baseline = {}
  for (const tag of Array.isArray(schema?.tags) ? schema.tags : []) {
    if (!['read', 'read-write'].includes(tag.access) || values[tag.id] == null) continue
    baseline[tag.id] = values[tag.id]
  }
  return baseline
}

export function advanceSimulationValue(currentValue, targetValue, ratePerSecond, elapsedSeconds, decimals = 2) {
  const current = Number(currentValue)
  const target = Number(targetValue)
  const rate = Number(ratePerSecond)
  const elapsed = Number(elapsedSeconds)
  if (![current, target, rate, elapsed].every(Number.isFinite) || rate <= 0 || elapsed <= 0) return current
  const difference = target - current
  if (difference === 0) return current
  const maximumStep = rate * elapsed
  const next = Math.abs(difference) <= maximumStep ? target : current + Math.sign(difference) * maximumStep
  return Number(next.toFixed(Math.max(0, Math.min(8, Number(decimals) || 0))))
}

export function applySimulationRpc(schema, values, request) {
  const method = String(request?.method || '')
  if (!method) return rejected('RPC method is required.')
  const components = Array.isArray(schema?.components) ? schema.components : []
  const tags = Array.isArray(schema?.tags) ? schema.tags : []
  const component = components.find(item => ['control-button', 'tuning-slider', 'operation-shifter'].includes(item.type) && item.properties?.rpcMethod === method)
  if (!component) return rejected(`RPC method ${method} is not mapped in the published project.`)
  const commandTag = tags.find(tag => tag.id === component.binding?.tagId)
  if (!commandTag) return rejected(`RPC method ${method} has no command tag.`)
  const feedbackTag = tags.find(tag => tag.id === component.properties?.feedbackTagId)
  const targetTag = feedbackTag || commandTag
  const requested = unwrapRpcParams(request.params)
  const current = values?.[targetTag.id] ?? initialMockValue(targetTag)

  if (component.type === 'operation-shifter') {
    const evaluated = evaluateOperationShift(component, commandTag, requested, components)
    if (!evaluated.ok) return rejected(evaluated.message)
    const changes = { [commandTag.id]: evaluated.value.mode, [targetTag.id]: evaluated.value.mode }
    if (evaluated.value.mode === 'reset') {
      const controlledIds = new Set(component.properties?.controlledComponentIds || [])
      for (const controlled of components.filter(item => controlledIds.has(item.id) && item.type === 'control-button')) {
        const controlledTag = tags.find(tag => tag.id === controlled.binding?.tagId)
        const feedbackTag = tags.find(tag => tag.id === controlled.properties?.feedbackTagId) || controlledTag
        if (controlledTag?.dataType === 'boolean') changes[controlledTag.id] = false
        if (feedbackTag?.dataType === 'boolean') changes[feedbackTag.id] = false
      }
    }
    return accepted(component, method, changes, evaluated.message, { operation: evaluated.value })
  }

  if (/reset/i.test(method)) {
    const reset = parseBoolean(requested)
    if (reset !== true) return rejected('Reset requires params true.')
    const changes = Object.fromEntries(tags
      .filter(tag => ['read', 'read-write'].includes(tag.access))
      .map(tag => [tag.id, initialMockValue(tag)]))
    changes[commandTag.id] = true
    return accepted(component, method, changes, 'Simulation baseline restored.', { resetTagId: commandTag.id, resetAfterMs: Number(component.properties?.pulseMs || 300) })
  }

  let nextValue
  try {
    if (component.type === 'tuning-slider') {
      nextValue = validateTuningValue(component, requested)
    } else if (targetTag.dataType === 'boolean') {
      const parsed = parseBoolean(requested)
      if (parsed != null) nextValue = parsed
      else if (component.properties?.action === 'toggle-boolean' && requested == null) nextValue = !Boolean(current)
      else nextValue = coerceConnectorValue(component.properties?.payload, targetTag.dataType)
    } else {
      nextValue = coerceConnectorValue(requested ?? component.properties?.payload, targetTag.dataType)
    }
  } catch (error) {
    return rejected(error.message)
  }

  const changes = { [commandTag.id]: nextValue, [targetTag.id]: nextValue }
  const pulse = component.properties?.action === 'pulse'
    ? { resetTagId: targetTag.id, resetAfterMs: Number(component.properties?.pulseMs || 300) }
    : {}
  return accepted(component, method, changes, `${targetTag.path}=${String(nextValue)}`, pulse)
}

function validateTuningValue(component, input) {
  const value = Number(input)
  const min = Number(component.properties?.min ?? 0)
  const max = Number(component.properties?.max ?? 100)
  const step = Number(component.properties?.step ?? 1)
  if (!Number.isFinite(value) || value < min || value > max) throw new TypeError(`Value must be between ${min} and ${max}.`)
  const steps = (value - min) / step
  if (!Number.isFinite(step) || step <= 0 || Math.abs(steps - Math.round(steps)) > 1e-7) throw new TypeError(`Value must follow a step of ${step}.`)
  return Number(value.toFixed(10))
}

function unwrapRpcParams(params) {
  if (params && typeof params === 'object' && !Array.isArray(params) && 'value' in params) return params.value
  return params
}

function parseBoolean(value) {
  try { return coerceConnectorValue(value, 'boolean') } catch { return null }
}

function accepted(component, method, changes, message, extra = {}) {
  return {
    ok: true,
    componentId: component.id,
    changes,
    message,
    response: { success: true, status: 'acknowledged', method, message },
    ...extra,
  }
}

function rejected(message) {
  return {
    ok: false,
    changes: {},
    message,
    response: { success: false, status: 'rejected', reason: message },
  }
}
