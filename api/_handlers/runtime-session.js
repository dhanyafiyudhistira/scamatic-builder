import { createHash, randomBytes } from 'node:crypto'
import { connectMongo } from '../_lib/mongo.js'
import { Connector, ConnectorEnvironment, Project, ProjectVersion, RuntimeSession, RuntimeStreamSession, SimulationResponderLease } from '../_lib/models.js'
import { requireCsrf, requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { enforceRateLimit } from '../_lib/security.js'
import { usesServerlessConnectorExecution } from '../_lib/connector-execution.js'
import { runtimeProfileMetadata, runtimeUsesLiveTelemetry } from '../../shared/runtime-profile.js'
import { validRuntimeResponderGeneration, validRuntimeResponderId } from '../../shared/runtime-responder.js'
import { resolveRuntimeEngine } from '../../shared/runtime-engine.js'

export default async function handler(req, res, { resolveIsaacCanary = () => null, onRuntimeSessionCreated = () => {} } = {}) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  if (!requireCsrf(req, res, principal)) return
  const projectId = String(req.body?.projectId || '')
  if (!projectId || projectId.length > 120) return res.status(400).json({ error: 'A valid projectId is required.' })
  const responderId = validRuntimeResponderId(req.body?.responderId)
    ? String(req.body.responderId)
    : randomBytes(18).toString('base64url')
  const responderGeneration = validRuntimeResponderGeneration(req.body?.responderGeneration)
    ? Number(req.body.responderGeneration)
    : 1
  if (!(await enforceRateLimit(req, res, 'runtime-session', { limit: 20, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return
  await connectMongo()
  const project = await Project.findById(projectId)
  const authorization = project && await requireProjectPermission(principal, res, project, PERMISSIONS.RUNTIME_VIEW)
  if (!authorization) return
  if (!project.activeVersionId) return res.status(409).json({ error: 'Project has not been published.' })
  const version = await ProjectVersion.findById(project.activeVersionId).lean()
  if (!version) return res.status(409).json({ error: 'Active published version is unavailable.' })
  const profile = runtimeProfileMetadata(version.schema)
  const liveTelemetry = runtimeUsesLiveTelemetry(version.schema)
  const simulationBridge = profile.id === 'simulation'
    ? await simulationBridgeConfiguration(version.schema, project, principal, authorization.capabilities)
    : null
  const policy = runtimeSessionPolicy()
  const serverless = usesServerlessConnectorExecution()
  const streamEnabled = liveTelemetry && process.env.CONNECTOR_PLATFORM_ENABLED === 'true' && !serverless
  const isaacCanary = streamEnabled && req.body?.excludeEngine !== 'isaac' ? resolveIsaacCanary(project) : null
  const engine = resolveRuntimeEngine(project, { isaacAvailable: Boolean(isaacCanary?.url) })
  const streamUrl = streamEnabled
    ? engine.selected === 'isaac' ? isaacCanary.url : resolveRuntimeStreamUrl()
    : null
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Math.min(Date.now() + policy.ttlMs, new Date(principal.sessionExpiresAt).getTime()))
  const runtimeSession = await RuntimeSession.create({ _id: digest(token), authSessionId: principal.sessionId, userId: principal.id, workspaceId: principal.workspaceId, projectId, versionId: project.activeVersionId, engine: engine.selected, responderId, responderGeneration, capabilities: authorization.capabilities, expiresAt })
  await enforceRuntimeSessionCap(principal.sessionId, projectId, runtimeSession.id, policy.maxSessions)
  let stream = null
  if (streamEnabled) {
    const ticket = randomBytes(32).toString('base64url')
    const streamExpiresAt = new Date(Date.now() + policy.streamTicketTtlMs)
    await RuntimeStreamSession.create({ _id: digest(ticket), runtimeSessionId: runtimeSession.id, userId: principal.id, workspaceId: principal.workspaceId, projectId, versionId: project.activeVersionId, engine: engine.selected, expiresAt: streamExpiresAt })
    stream = { url: streamUrl, ticket, expiresAt: streamExpiresAt }
  }
  try { onRuntimeSessionCreated({ projectId, workspaceId: principal.workspaceId, runtimeSessionId: runtimeSession.id }) } catch {}
  return res.status(201).json({
    token,
    expiresAt,
    responder: { id: responderId, generation: responderGeneration },
    capabilities: authorization.capabilities,
    profile,
    engine,
    stream,
    telemetry: !liveTelemetry
      ? {
          mode: 'simulation',
          intervalMs: 500,
          visualIntervalMs: 500,
          publishIntervalMs: 1000,
          heartbeatIntervalMs: 20_000,
          bridge: simulationBridge,
        }
      : serverless
      ? { mode: 'poll', intervalMs: boundedInteger(process.env.CONNECTOR_POLL_INTERVAL_MS, 1000, 10_000, 2000) }
      : { mode: streamEnabled ? 'stream' : 'snapshot' },
  })
}

async function simulationBridgeConfiguration(schema, project, principal, capabilities) {
  if (!capabilities.includes(PERMISSIONS.COMMAND_EXECUTE)) {
    return { mode: 'local', available: false, reason: 'Simulation Bridge requires command.execute permission.' }
  }
  const source = (schema?.dataSources || []).find(item => item.type === 'thingsboard')
  if (!source) return { mode: 'local', available: false, reason: 'Attach a ThingsBoard source to enable the RWTest-compatible bridge.' }
  const connector = await Connector.findOne({ _id: source.connectorRef, workspaceId: principal.workspaceId, projectId: project.id, enabled: true }).lean()
  const environment = connector && await ConnectorEnvironment.findOne({ connectorId: connector._id, environmentRef: source.environmentRef || 'staging' }).lean()
  if (!connector || !environment?.deviceTokenConfiguredAt) {
    return { mode: 'local', available: false, reason: 'Enable the connector and configure its Simulation device token.' }
  }
  return {
    mode: 'thingsboard-device',
    available: true,
    connectorName: connector.name,
    environmentRef: environment.environmentRef,
    telemetryPublish: true,
    rpcListening: true,
  }
}
function digest(value) { return createHash('sha256').update(String(value)).digest('hex') }

export function resolveRuntimeStreamUrl() {
  const configured = String(process.env.CONNECTOR_STREAM_PUBLIC_URL || '').trim()
  if (!configured && process.env.CONNECTOR_STREAM_MODE === 'embedded') return embeddedRuntimeStreamUrl()
  if (!configured && process.env.NODE_ENV === 'production') throw Object.assign(new Error('CONNECTOR_STREAM_PUBLIC_URL is required in production.'), { statusCode: 503 })
  if (!configured) return `ws://localhost:${process.env.CONNECTOR_STREAM_PORT || 3002}/runtime-stream`
  let url
  try { url = new URL(configured) } catch { throw Object.assign(new Error('CONNECTOR_STREAM_PUBLIC_URL is invalid.'), { statusCode: 503 }) }
  const validProtocol = process.env.NODE_ENV === 'production' ? url.protocol === 'wss:' : ['ws:', 'wss:'].includes(url.protocol)
  if (!validProtocol || url.username || url.password || url.search || url.hash) throw Object.assign(new Error('CONNECTOR_STREAM_PUBLIC_URL must be a clean WebSocket URL.'), { statusCode: 503 })
  if (url.pathname === '/') url.pathname = '/runtime-stream'
  return url.toString().replace(/\/$/, '')
}

function embeddedRuntimeStreamUrl() {
  const configuredOrigin = String(process.env.APP_ORIGIN || '').split(',').map(value => value.trim()).find(Boolean)
  if (!configuredOrigin) {
    if (process.env.NODE_ENV === 'production') throw Object.assign(new Error('APP_ORIGIN is required for the embedded runtime stream in production.'), { statusCode: 503 })
    return `ws://localhost:${process.env.PORT || 3001}/runtime-stream`
  }
  let url
  try { url = new URL(configuredOrigin) } catch { throw Object.assign(new Error('APP_ORIGIN is invalid.'), { statusCode: 503 }) }
  const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const validProtocol = url.protocol === 'https:' || loopbackHttp || (process.env.NODE_ENV !== 'production' && url.protocol === 'http:')
  if (!validProtocol || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Object.assign(new Error('APP_ORIGIN must be a clean HTTP origin.'), { statusCode: 503 })
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/runtime-stream'
  return url.toString()
}

export function runtimeSessionPolicy() {
  return {
    ttlMs: boundedInteger(process.env.SCADA_RUNTIME_SESSION_SECONDS, 5 * 60, 60 * 60, 30 * 60) * 1000,
    streamTicketTtlMs: boundedInteger(process.env.SCADA_STREAM_TICKET_SECONDS, 15, 120, 60) * 1000,
    maxSessions: boundedInteger(process.env.SCADA_MAX_RUNTIME_SESSIONS, 1, 20, 5),
  }
}

async function enforceRuntimeSessionCap(authSessionId, projectId, currentSessionId, maximum) {
  const sessions = await RuntimeSession.find({ authSessionId, projectId, revokedAt: null, _id: { $ne: currentSessionId }, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).select({ _id: 1 }).lean()
  const excess = sessions.slice(Math.max(0, maximum - 1)).map(session => session._id)
  if (!excess.length) return
  const revokedAt = new Date()
  await Promise.all([
    RuntimeSession.updateMany({ _id: { $in: excess }, revokedAt: null }, { $set: { revokedAt } }),
    RuntimeStreamSession.updateMany({ runtimeSessionId: { $in: excess }, revokedAt: null }, { $set: { revokedAt } }),
    SimulationResponderLease.deleteMany({ runtimeSessionId: { $in: excess } }),
  ])
}
function boundedInteger(value, min, max, fallback) { const number = Number(value); return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback }
