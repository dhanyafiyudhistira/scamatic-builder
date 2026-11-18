import express from 'express'
import compression from 'compression'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import auth from '../api/_handlers/auth.js'
import runtime from '../api/_handlers/runtime.js'
import runtimeSession from '../api/_handlers/runtime-session.js'
import telemetry from '../api/_handlers/runtime-telemetry.js'
import history from '../api/_handlers/telemetry.js'
import commands from '../api/_handlers/commands.js'
import simulationSequence from '../api/_handlers/simulation-sequence.js'
import { connectMongo, pingMongo } from '../api/_lib/mongo.js'
import { requirePrincipal, requireCsrf } from '../api/_lib/auth.js'
import { requireProjectPermission, PERMISSIONS } from '../api/_lib/authorization.js'
import { Project, RuntimeSession, ScadaAsset, AuditEvent } from '../api/_lib/models.js'
import { verifyProjectPin, grantProjectUnlock } from '../api/_lib/project-pin.js'
import { enforceRateLimit } from '../api/_lib/security.js'
import { verifyDeployment } from './contract.js'
import { hostedRuntimeAccess, hostedRuntimeProfile } from '../shared/hosted-runtime-policy.js'

const methods = Object.freeze({ auth: ['GET', 'POST', 'DELETE'], runtime: ['GET'], 'runtime-session': ['POST'], 'runtime-telemetry': ['GET'], telemetry: ['GET', 'POST'], elements: ['GET'], projects: ['PATCH'], commands: ['GET', 'POST'], 'simulation-sequence': ['POST'] })

export function runtimeRequestAllowed(deployment, route, method, query = {}, body = {}) {
  if (!Object.hasOwn(methods, route) || !methods[route].includes(method)) return false
  const { project, version, assets } = deployment.payload
  const simulation = deployment.policy === 'simulation'
  if (route === 'commands' && method === 'POST' && !simulation) return false
  if (route === 'simulation-sequence' && (!simulation || !['start', 'step'].includes(body.action))) return false
  if (route === 'telemetry' && method === 'POST' && (!simulation || body.source !== 'runtime-simulation')) return false
  if (route === 'runtime-telemetry' && simulation) return false
  for (const input of [query, body]) {
    if (input.projectId !== undefined && input.projectId !== project.id) return false
    if (input.workspaceId !== undefined && input.workspaceId !== project.workspaceId) return false
    if (input.versionId !== undefined && input.versionId !== version.id) return false
    if (input.id !== undefined && input.id !== project.id) return false
  }
  if (route === 'runtime') return query.slug === project.slug
  if (route === 'auth') return method !== 'POST' || Object.keys(body).every(key => ['email', 'password'].includes(key))
  if (route === 'projects') return body.action === 'unlock' && body.projectId === project.id && Object.keys(body).every(key => ['projectId', 'action', 'pin'].includes(key))
  if (route === 'elements') return query.projectId === project.id && assets.some(asset => asset._id === query.assetId && asset.kind === 'design-image')
  return (method === 'GET' ? query.projectId : body.projectId) === project.id
}

async function unlock(req, res, deployment) {
  const principal = await requirePrincipal(req, res)
  if (!principal || !requireCsrf(req, res, principal)) return
  if (!(await enforceRateLimit(req, res, 'hosted-pin', { limit: 8, windowMs: 600_000, identity: `${principal.id}:${deployment.payload.project.id}` }))) return
  await connectMongo()
  const project = await Project.findById(deployment.payload.project.id).select('+security.pinHash')
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.RUNTIME_VIEW, { bypassProjectLock: true }))) return
  if (project.security?.pinEnabled && !(await verifyProjectPin(req.body.pin, project.security.pinHash))) return res.status(403).json({ error: 'Invalid project PIN.' })
  await grantProjectUnlock(principal, project)
  await AuditEvent.create({ actorId: principal.id, workspaceId: project.workspaceId, projectId: project.id, action: 'project.pin.unlocked', targetType: 'project', targetId: project.id })
  return res.json({ ok: true })
}

async function asset(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  await connectMongo()
  const project = await Project.findById(req.query.projectId)
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.RUNTIME_VIEW))) return
  const record = await ScadaAsset.findOne({ _id: req.query.assetId, projectId: project.id, kind: 'design-image' }).lean()
  if (!record) return res.status(404).json({ error: 'Asset not found.' })
  res.setHeader('Cache-Control', 'private, no-store')
  res.type(record.metadata.mimeType).send(record.metadata.mimeType === 'image/svg+xml' ? record.content : Buffer.from(record.content, 'base64'))
}

async function commandHistory(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  await connectMongo()
  const project = await Project.findById(req.query.projectId)
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.RUNTIME_VIEW))) return
  const token = createHash('sha256').update(String(req.headers['x-runtime-token'] || '')).digest('hex')
  if (!(await RuntimeSession.exists({ _id: token, authSessionId: principal.sessionId, projectId: project.id, versionId: project.activeVersionId, revokedAt: null, expiresAt: { $gt: new Date() } }))) return res.status(403).json({ error: 'Runtime session is invalid.' })
  return res.json({ commands: [] })
}

export function createRuntimeApp({ deployment, root, ready = async () => {}, handlers = {} }) {
  verifyDeployment(deployment)
  const simulation = deployment.policy === 'simulation'
  const access = hostedRuntimeAccess(deployment.policy)
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(compression())
  app.use(express.json({ limit: '64kb' }))
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
    if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000')
    if (req.path.startsWith('/api/') || req.path.startsWith('/health')) res.setHeader('Cache-Control', 'no-store')
    next()
  })
  const routes = {
    auth,
    runtime: (req, res) => runtime(req, res, { simulationOnly: simulation }),
    'runtime-session': (req, res) => runtimeSession(req, res, { simulationOnly: simulation }),
    'runtime-telemetry': telemetry,
    telemetry: history,
    elements: asset,
    projects: (req, res) => unlock(req, res, deployment),
    commands: simulation ? (req, res) => commands(req, res, { simulationOnly: true }) : commandHistory,
    'simulation-sequence': simulationSequence,
    ...handlers,
  }
  app.get('/api/runtime-info', (req, res) => res.json({ slug: deployment.payload.project.slug, projectType: deployment.payload.project.projectType, policy: deployment.policy, engineVersion: deployment.engineVersion }))
  app.get('/health/live', (req, res) => res.json({ ok: true }))
  app.get(['/health/ready', '/api/health'], async (req, res) => {
    try { await ready(); await pingMongo({ requireTransactions: true }); res.json({ ok: true, policy: deployment.policy, version: deployment.payload.version.number }) }
    catch { res.status(503).json({ ok: false, error: 'Runtime provisioning or database is unavailable.' }) }
  })
  app.all('/api/:route', async (req, res, next) => {
    const route = req.params.route
    if (!runtimeRequestAllowed(deployment, route, req.method, req.query, req.body || {})) return res.status(404).json({ error: 'Runtime route is unavailable.', code: 'RUNTIME_ROUTE_UNAVAILABLE' })
    try {
      await ready()
      // The active pointer must still match this immutable package after redeploy.
      if (!handlers[route] && route !== 'auth') {
        await connectMongo()
        const current = await Project.findOne({ _id: deployment.payload.project.id, workspaceId: deployment.payload.project.workspaceId }).select({ activeVersionId: 1 }).lean()
        if (current?.activeVersionId !== deployment.payload.version.id) return res.status(409).json({ error: 'Deployment version has changed. Reload the runtime.', code: 'DEPLOYMENT_VERSION_CHANGED' })
      }
      const json = res.json.bind(res)
      res.json = data => {
        if (data?.user) data = { ...data, user: { ...data.user, ...access, workspaces: undefined } }
        if (data?.profile) {
          data = { ...data, profile: hostedRuntimeProfile(data.profile, deployment.policy), capabilities: access.capabilities, deployment: { policy: deployment.policy } }
          if (simulation && data.telemetry) data = { ...data, stream: null, telemetry: { ...data.telemetry, mode: 'simulation', bridge: { mode: 'local', available: false, reason: 'Hosted internal simulation.' } } }
        }
        return json(data)
      }
      await routes[route](req, res)
    } catch (error) { next(error) }
  })
  app.use('/api', (req, res) => res.status(404).json({ error: 'Runtime route is unavailable.' }))
  app.use(express.static(resolve(root, 'dist'), { index: false, dotfiles: 'deny' }))
  app.get(['/', `/runtime/${deployment.payload.project.slug}`], (req, res) => res.sendFile(resolve(root, 'dist/index.html')))
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }))
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    res.status(error?.type === 'entity.too.large' ? 413 : error?.type === 'entity.parse.failed' ? 400 : 503).json({ error: 'Runtime request could not be completed.', code: 'HOSTED_RUNTIME_UNAVAILABLE' })
  })
  return app
}
