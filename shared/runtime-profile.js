export const RUNTIME_PROFILES = Object.freeze(['simulation', 'real', 'monitor'])

export const RUNTIME_PROFILE_META = Object.freeze({
  simulation: Object.freeze({
    label: 'SIMULATION',
    description: 'RWTest-compatible device simulation. It can publish telemetry and answer ThingsBoard RPC without commanding the physical PLC.',
    commandEnabled: true,
    liveTelemetry: false,
  }),
  real: Object.freeze({
    label: 'REAL PLC',
    description: 'Live ThingsBoard control. An active edge gateway and fresh PLC feedback are required.',
    commandEnabled: true,
    liveTelemetry: true,
  }),
  monitor: Object.freeze({
    label: 'MONITOR ONLY',
    description: 'Live telemetry remains visible while every command is blocked by the server.',
    commandEnabled: false,
    liveTelemetry: true,
  }),
})

export function runtimeProfile(schema) {
  const configured = String(schema?.project?.runtimeProfile || '').trim().toLowerCase()
  if (RUNTIME_PROFILES.includes(configured)) return configured
  return (schema?.dataSources || []).some(source => source?.type && source.type !== 'mock')
    ? 'real'
    : 'simulation'
}

export function runtimeProfileMetadata(schemaOrProfile) {
  const profile = typeof schemaOrProfile === 'string'
    ? (RUNTIME_PROFILES.includes(schemaOrProfile) ? schemaOrProfile : 'simulation')
    : runtimeProfile(schemaOrProfile)
  return { id: profile, ...RUNTIME_PROFILE_META[profile] }
}

export function runtimeAllowsCommands(schema) {
  return runtimeProfile(schema) !== 'monitor'
}

export function runtimeUsesLiveTelemetry(schema) {
  return runtimeProfile(schema) !== 'simulation'
}

export function runtimeCommandExecutionPlan(schema, { sourceType, serverlessAvailable = false } = {}) {
  const profile = runtimeProfile(schema)
  if (profile === 'monitor') return { executionMode: null, initialStatus: null }
  if (profile === 'simulation') return { executionMode: 'mock', initialStatus: 'requested' }
  if (sourceType !== 'mock' && serverlessAvailable) {
    return { executionMode: 'serverless', initialStatus: 'dispatched' }
  }
  return { executionMode: 'worker', initialStatus: 'requested' }
}
