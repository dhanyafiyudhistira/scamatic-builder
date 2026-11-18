import { runtimeProfile } from './runtime-profile.js'

export function hostedRuntimePolicy(schema) {
  return runtimeProfile(schema) === 'simulation' ? 'simulation' : 'monitor-only'
}

export function hostedRuntimeAccess(policy) {
  return policy === 'simulation'
    ? { role: 'OPERATOR', capabilities: ['runtime.view', 'command.execute'] }
    : { role: 'VIEWER', capabilities: ['runtime.view'] }
}

export function hostedRuntimeProfile(profile, policy) {
  const simulation = policy === 'simulation' && profile?.id === 'simulation'
  return {
    ...profile,
    commandEnabled: simulation,
    ...(simulation ? { description: 'Hosted internal simulation. Controls affect simulated values in this runtime.' } : {}),
  }
}
