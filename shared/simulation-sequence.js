import { evaluateOperationShift } from './runtime-evaluator.js'

export function buildSimulationSequencePlan(schema, operationComponentId, enabledStepIds) {
  const components = Array.isArray(schema?.components) ? schema.components : []
  const tags = Array.isArray(schema?.tags) ? schema.tags : []
  const operation = components.find(component => component.id === operationComponentId && component.type === 'operation-shifter')
  if (!operation) throw sequenceError('Simulation sequence controller is not present in the published project.', 'SIMULATION_SEQUENCE_CONTROLLER_INVALID')
  const operationTag = tags.find(tag => tag.id === operation.binding?.tagId)
  if (!operationTag || !['write', 'read-write'].includes(operationTag.access)) {
    throw sequenceError('Simulation sequence controller requires a writable operation tag.', 'SIMULATION_SEQUENCE_TAG_INVALID')
  }
  const evaluated = evaluateOperationShift(operation, operationTag, { mode: 'auto', enabledStepIds }, components)
  if (!evaluated.ok) throw sequenceError(evaluated.message, 'SIMULATION_SEQUENCE_INVALID')
  return {
    operation,
    operationTag,
    steps: evaluated.value.sequence,
  }
}

export function resolveSimulationSequenceStep(schema, operationComponentId, stepId, enabledStepIds) {
  const plan = buildSimulationSequencePlan(schema, operationComponentId, enabledStepIds)
  const step = plan.steps.find(item => item.id === String(stepId || ''))
  if (!step) throw sequenceError('Simulation sequence step is not enabled in the authorized recipe.', 'SIMULATION_SEQUENCE_STEP_INVALID')

  const components = Array.isArray(schema?.components) ? schema.components : []
  const tags = Array.isArray(schema?.tags) ? schema.tags : []
  const component = components.find(item => item.id === step.componentId && item.type === 'control-button')
  const commandTag = tags.find(tag => tag.id === component?.binding?.tagId)
  if (!component || !commandTag || commandTag.dataType !== 'boolean' || !['write', 'read-write'].includes(commandTag.access)) {
    throw sequenceError('Simulation sequence step requires a writable boolean Control Button.', 'SIMULATION_SEQUENCE_TARGET_INVALID')
  }
  const feedbackTag = tags.find(tag => tag.id === component.properties?.feedbackTagId)
  if (feedbackTag && (feedbackTag.dataType !== 'boolean' || !['read', 'read-write'].includes(feedbackTag.access))) {
    throw sequenceError('Simulation sequence feedback must be a readable boolean tag.', 'SIMULATION_SEQUENCE_FEEDBACK_INVALID')
  }
  const changes = { [commandTag.id]: step.value }
  if (feedbackTag) changes[feedbackTag.id] = step.value
  return {
    ...plan,
    step,
    component,
    commandTag,
    feedbackTag: feedbackTag || null,
    changes,
  }
}

function sequenceError(message, code) {
  return Object.assign(new TypeError(message), { code })
}
