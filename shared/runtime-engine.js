export const RUNTIME_ENGINES = Object.freeze(['standard', 'isaac'])
export const STANDARD_RUNTIME_ENGINE = 'standard'
export const ISAAC_RUNTIME_ENGINE = 'isaac'

export const RUNTIME_ENGINE_META = Object.freeze({
  standard: Object.freeze({
    label: 'STANDARD',
    description: 'Proven Node.js runtime data-plane with the existing telemetry and command path.',
  }),
  isaac: Object.freeze({
    label: 'ISAAC · FAST RUNTIME',
    description: 'Preferred Rust/Axum fast data-plane. Standard is used safely until the Isaac gateway is available.',
  }),
})

export function validRuntimeEngine(value) {
  return RUNTIME_ENGINES.includes(String(value || '').trim().toLowerCase())
}

export function runtimeEngine(value) {
  const candidate = typeof value === 'string' ? value : value?.runtimeEnginePreference ?? value?.engine
  const normalized = String(candidate || '').trim().toLowerCase()
  return validRuntimeEngine(normalized) ? normalized : STANDARD_RUNTIME_ENGINE
}

export function runtimeEngineMetadata(value) {
  const id = runtimeEngine(value)
  return { id, ...RUNTIME_ENGINE_META[id] }
}

export function resolveRuntimeEngine(value, { isaacAvailable = false } = {}) {
  const requested = runtimeEngine(value)
  if (requested === ISAAC_RUNTIME_ENGINE && isaacAvailable !== true) {
    return Object.freeze({
      requested,
      selected: STANDARD_RUNTIME_ENGINE,
      fallbackReason: 'ISAAC_UNAVAILABLE',
    })
  }
  return Object.freeze({ requested, selected: requested, fallbackReason: null })
}

export function isaacCanarySelected(value) {
  return value?.isaacCanaryEnabled === true && runtimeEngine(value) === ISAAC_RUNTIME_ENGINE
}

export function applyIsaacCanarySelection(project, enabled) {
  const selected = enabled === true
  project.isaacCanaryEnabled = selected
  project.runtimeEnginePreference = selected ? ISAAC_RUNTIME_ENGINE : STANDARD_RUNTIME_ENGINE
  return project
}
