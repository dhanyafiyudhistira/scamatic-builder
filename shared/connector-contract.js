export const CONNECTOR_TYPES = Object.freeze(['mock', 'thingsboard'])
export const CONNECTOR_ENVIRONMENTS = Object.freeze(['development', 'staging', 'production'])
export const CONNECTOR_QUALITIES = Object.freeze(['good', 'stale', 'bad', 'disconnected'])
export const CONNECTOR_HEALTH_STATES = Object.freeze(['unconfigured', 'connecting', 'online', 'degraded', 'offline', 'error'])
export const COMMAND_STATUSES = Object.freeze(['requested', 'authorized', 'dispatched', 'accepted_by_gateway', 'acknowledged', 'rejected', 'timeout', 'failed'])

export function coerceConnectorValue(value, dataType) {
  if (dataType === 'boolean') {
    if (value === true || value === false) return value
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value
    if (normalized === 1 || ['1', 'true', 'on', 'yes'].includes(normalized)) return true
    if (normalized === 0 || ['0', 'false', 'off', 'no'].includes(normalized)) return false
    throw new TypeError(`Cannot coerce ${previewConnectorValue(value)} to boolean.`)
  }
  if (dataType === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new TypeError(`Cannot coerce value to number.`)
    return number
  }
  if (dataType === 'datetime') {
    const timestamp = new Date(value)
    if (Number.isNaN(timestamp.getTime())) throw new TypeError(`Cannot coerce value to datetime.`)
    return timestamp.toISOString()
  }
  if (dataType === 'string' || dataType === 'enum') return String(value)
  throw new TypeError(`Unsupported connector data type: ${dataType}.`)
}

function previewConnectorValue(value) {
  let rendered
  try { rendered = JSON.stringify(value) } catch { rendered = String(value) }
  if (rendered == null) rendered = String(value)
  return `${typeof value} value ${rendered.slice(0, 80)}`
}

export function normalizeTagEvent({ workspaceId, projectId, sourceId, tag, value, sourceTimestamp, receivedAt = new Date().toISOString(), quality = 'good', sequence }) {
  if (!workspaceId || !projectId || !sourceId || !tag?.id) throw new TypeError('Normalized events require workspace, project, source, and tag identifiers.')
  if (!CONNECTOR_QUALITIES.includes(quality)) throw new TypeError(`Unsupported quality: ${quality}.`)
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('Normalized events require a positive sequence.')
  return Object.freeze({
    workspaceId: String(workspaceId),
    projectId: String(projectId),
    sourceId: String(sourceId),
    tagId: String(tag.id),
    value: coerceConnectorValue(value, tag.dataType),
    dataType: tag.dataType,
    sourceTimestamp: new Date(sourceTimestamp || receivedAt).toISOString(),
    receivedAt: new Date(receivedAt).toISOString(),
    quality,
    sequence,
  })
}

export function publicConnector(connector, environment = null) {
  const commandHealth = environment?.commandHealth?.state === 'offline'
    ? {
        ...environment.commandHealth,
        state: 'unverified',
        message: environment.commandHealth.message || 'Legacy command timeout; outcome is unverified.',
      }
    : environment?.commandHealth
  const storedAuthentication = environment?.authentication?.toObject?.() || environment?.authentication || {}
  const authentication = environment?.secretConfiguredAt
    ? {
        mode: !storedAuthentication.mode || storedAuthentication.mode === 'unconfigured' ? 'manual-jwt' : storedAuthentication.mode,
        state: !storedAuthentication.state || storedAuthentication.state === 'unconfigured' ? 'manual' : storedAuthentication.state,
        message: !storedAuthentication.message || storedAuthentication.message === 'ThingsBoard authentication is not configured.' ? 'Manual JWT rotation is active.' : storedAuthentication.message,
        accessTokenExpiresAt: storedAuthentication.accessTokenExpiresAt || null,
        refreshTokenExpiresAt: storedAuthentication.refreshTokenExpiresAt || null,
        lastRefreshedAt: storedAuthentication.lastRefreshedAt || null,
        lastRefreshAttemptAt: storedAuthentication.lastRefreshAttemptAt || null,
      }
    : {
        mode: 'unconfigured',
        state: 'unconfigured',
        message: 'ThingsBoard authentication is not configured.',
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        lastRefreshedAt: null,
        lastRefreshAttemptAt: null,
      }
  return {
    id: String(connector._id || connector.id),
    projectId: connector.projectId,
    name: connector.name,
    type: connector.type,
    enabled: Boolean(connector.enabled),
    environment: environment ? {
      id: String(environment._id || environment.id),
      environmentRef: environment.environmentRef,
      config: environment.config || {},
      health: environment.health || { state: 'unconfigured' },
      commandHealth: commandHealth || { state: 'unknown', message: 'No RPC result observed yet.' },
      authentication,
      secret: {
        configured: Boolean(environment.secretConfiguredAt),
        lastRotatedAt: environment.secretConfiguredAt || null,
      },
      simulationSecret: {
        configured: Boolean(environment.deviceTokenConfiguredAt),
        lastRotatedAt: environment.deviceTokenConfiguredAt || null,
      },
    } : null,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  }
}
