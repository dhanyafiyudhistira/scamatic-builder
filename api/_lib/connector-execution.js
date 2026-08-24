export function connectorExecutionMode(environment = process.env) {
  const configured = String(environment.CONNECTOR_EXECUTION_MODE || '').trim().toLowerCase()
  if (configured === 'serverless' || configured === 'worker') return configured
  return environment.VERCEL ? 'serverless' : 'worker'
}

export function usesServerlessConnectorExecution(environment = process.env) {
  return connectorExecutionMode(environment) === 'serverless'
}

export function connectorEnvironmentReadiness(environment, {
  executionMode = connectorExecutionMode(),
  now = Date.now(),
  workerHeartbeatMaxAgeMs = 45_000,
} = {}) {
  if (!environment?.secretConfiguredAt) return { ready: false, reason: 'secret' }
  if (environment?.health?.state !== 'online') return { ready: false, reason: 'health' }
  if (executionMode === 'serverless') return { ready: true, reason: 'online' }
  const checkedAt = new Date(environment?.health?.checkedAt || 0).getTime()
  const heartbeatFresh = Number.isFinite(checkedAt) && now - checkedAt < workerHeartbeatMaxAgeMs
  return heartbeatFresh
    ? { ready: true, reason: 'heartbeat' }
    : { ready: false, reason: 'heartbeat' }
}
