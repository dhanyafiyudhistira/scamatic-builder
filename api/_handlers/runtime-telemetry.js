import { createHash } from 'node:crypto'
import { connectMongo } from '../_lib/mongo.js'
import { Connector, ConnectorEnvironment, Project, ProjectVersion, RuntimeSession, TagValueSnapshot } from '../_lib/models.js'
import { requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { enforceRateLimit, requestId } from '../_lib/security.js'
import { readThingsBoardLatestTelemetry, telemetryEventFromLatest } from '../_lib/thingsboard-serverless.js'
import { runtimeUsesLiveTelemetry } from '../../shared/runtime-profile.js'
import { withThingsBoardAccessToken } from '../_lib/thingsboard-auth.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }

  const projectId = String(req.query?.projectId || '')
  const runtimeToken = String(req.headers?.['x-runtime-token'] || '')
  const correlationId = requestId(req)
  if (!projectId || !runtimeToken) {
    return res.status(400).json({ error: 'projectId and X-Runtime-Token are required.', code: 'RUNTIME_TELEMETRY_INPUT_INVALID', correlationId })
  }
  if (!(await enforceRateLimit(req, res, 'runtime-telemetry-poll', { limit: 90, windowMs: 60_000, identity: `${principal.id}:${projectId}` }))) return

  try {
    await connectMongo()
    const project = await Project.findById(projectId)
    const authorization = project && await requireProjectPermission(principal, res, project, PERMISSIONS.RUNTIME_VIEW)
    if (!authorization) return
    const runtimeSession = await RuntimeSession.findOne({
      _id: digest(runtimeToken),
      authSessionId: principal.sessionId,
      userId: principal.id,
      projectId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).lean()
    if (!runtimeSession || runtimeSession.versionId !== project.activeVersionId) {
      return res.status(403).json({ error: 'Runtime session is invalid or stale.', code: 'RUNTIME_SESSION_INVALID', correlationId })
    }

    const version = await ProjectVersion.findById(project.activeVersionId).lean()
    if (!runtimeUsesLiveTelemetry(version?.schema)) {
      return res.status(409).json({ error: 'Simulation profile does not poll live telemetry.', code: 'SIMULATION_TELEMETRY_LOCAL', correlationId })
    }
    const events = []
    const failures = []
    const sources = (version?.schema?.dataSources || []).filter(source => source.type === 'thingsboard')
    for (const source of sources) {
      const tags = (version.schema.tags || []).filter(tag => tag.sourceId === source.id && ['read', 'read-write'].includes(tag.access))
      if (!tags.length) continue
      try {
        const connector = await Connector.findOne({ _id: source.connectorRef, workspaceId: principal.workspaceId, projectId, enabled: true }).lean()
        const environmentRef = source.environmentRef || 'staging'
        const environment = connector && await ConnectorEnvironment.findOne({ connectorId: connector._id, environmentRef }).lean()
        if (!connector || !environment?.secretConfiguredAt) throw Object.assign(new Error('Connector configuration is incomplete.'), { code: 'CONNECTOR_UNAVAILABLE' })
        const latest = await withThingsBoardAccessToken(
          { connectorId: connector._id, environmentRef },
          jwt => readThingsBoardLatestTelemetry({ config: environment.config, jwt, keys: tags.map(tag => tag.path) }),
        )
        const receivedAt = Date.now()
        for (const tag of tags) {
          const event = latest[tag.path] && telemetryEventFromLatest({
            workspaceId: principal.workspaceId,
            projectId,
            sourceId: source.id,
            tag,
            sample: latest[tag.path],
            receivedAt,
          })
          if (event) events.push(event)
        }
        await ConnectorEnvironment.updateOne({ _id: environment._id }, {
          $set: {
            health: {
              state: 'online',
              message: 'ThingsBoard telemetry poll succeeded.',
              checkedAt: new Date(receivedAt),
              connectedAt: environment.health?.connectedAt || new Date(receivedAt),
              lastEventAt: events.length ? new Date(receivedAt) : environment.health?.lastEventAt || null,
            },
          },
        })
      } catch (error) {
        failures.push({ sourceId: source.id, code: String(error?.code || error?.name || 'TELEMETRY_FAILED').slice(0, 80) })
      }
    }

    if (events.length) {
      await TagValueSnapshot.bulkWrite(events.map(event => ({
        updateOne: {
          filter: { _id: `${event.projectId}:${event.tagId}` },
          update: { $set: { ...event, sourceTimestamp: new Date(event.sourceTimestamp), receivedAt: new Date(event.receivedAt) } },
          upsert: true,
        },
      })), { ordered: false })
    }
    return res.status(200).json({
      events,
      state: failures.length ? 'degraded' : 'online',
      failures,
      polledAt: new Date().toISOString(),
      correlationId,
    })
  } catch {
    return res.status(503).json({ error: 'Runtime telemetry is temporarily unavailable.', code: 'RUNTIME_TELEMETRY_UNAVAILABLE', correlationId })
  }
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}
