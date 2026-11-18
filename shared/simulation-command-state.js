import { initialMockValue } from './runtime-evaluator.js'

export function simulationCommandState(schema, commands = []) {
  const components = new Map((schema?.components || []).map(component => [component.id, component]))
  const tags = new Map((schema?.tags || []).map(tag => [tag.id, tag]))
  const state = new Map()

  for (const command of commands || []) {
    const component = components.get(command.componentId)
    if (!component || command.status !== 'acknowledged' || command.executionMode !== 'mock') continue
    const completedAt = command.completedAt || command.updatedAt || command.createdAt || new Date()
    const sequence = new Date(completedAt).getTime()
    const store = (tagId, value) => {
      if (!tagId || state.has(tagId)) return
      state.set(tagId, { value, timestamp: completedAt, receivedAt: completedAt, quality: 'good', sequence })
    }

    if (component.type === 'operation-shifter') {
      const mode = String(command.resultSummary?.value?.mode || '').toLowerCase()
      if (!['manual', 'auto', 'reset'].includes(mode)) continue
      if (mode === 'reset') {
        for (const controlledId of component.properties?.controlledComponentIds || []) {
          const controlled = components.get(controlledId)
          if (controlled?.type !== 'control-button') continue
          const commandTag = tags.get(controlled.binding?.tagId)
          const feedbackTag = tags.get(controlled.properties?.feedbackTagId)
          if (commandTag?.dataType === 'boolean') store(commandTag.id, false)
          if (feedbackTag?.dataType === 'boolean') store(feedbackTag.id, false)
        }
      }
      store(component.binding?.tagId, mode)
      store(component.properties?.feedbackTagId, mode)
      continue
    }

    if (component.type === 'tuning-slider' || component.properties?.action === 'pulse' || command.resultSummary?.value == null) continue
    store(command.tagId || component.binding?.tagId, command.resultSummary.value)
    store(component.properties?.feedbackTagId, command.resultSummary.value)
  }
  return state
}

export function newestSimulationSample(snapshot, restored) {
  if (!snapshot) return restored || null
  if (!restored) return snapshot
  return sampleTimestamp(restored) > sampleTimestamp(snapshot) ? restored : snapshot
}

export function reconcileSimulationControlState(schema, values = {}) {
  const reconciled = { ...values }
  for (const component of schema?.components || []) {
    if (component?.type !== 'control-button' || (component.properties?.action || 'toggle-boolean') !== 'toggle-boolean') continue
    const commandTagId = component.binding?.tagId
    const feedbackTagId = component.properties?.feedbackTagId
    if (!commandTagId || !feedbackTagId || !reconciled[feedbackTagId]) continue
    // A write-only command tag is an intent channel, not an observed state.
    // Mirror the readable feedback at bootstrap so the first toggle after a
    // reload cannot repeat the already-visible device state.
    reconciled[commandTagId] = { ...reconciled[feedbackTagId] }
  }
  return reconciled
}

export function previousSimulationCommandValue(schema, commands, component, tag) {
  return simulationCommandState(schema, commands).get(tag?.id)?.value ?? initialMockValue(tag)
}

export function simulationCommandReadScope(schema, component, tag) {
  const action = component?.properties?.action || 'toggle-boolean'
  if (component?.type !== 'control-button' || action !== 'toggle-boolean' || !component.id || !tag?.id) return null
  const resetComponentIds = (schema?.components || [])
    .filter(item => item?.type === 'operation-shifter' && item.properties?.controlledComponentIds?.includes(component.id))
    .map(item => item.id)
    .filter(Boolean)
  return { componentId: component.id, tagId: tag.id, resetComponentIds }
}

export function simulationCommandHistoryRequired(component, requestedValue) {
  const action = component?.properties?.action || 'toggle-boolean'
  return component?.type === 'control-button' && action === 'toggle-boolean' && requestedValue === undefined
}

function sampleTimestamp(sample) {
  const parsed = new Date(sample?.timestamp ?? sample?.sourceTimestamp ?? 0).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}
