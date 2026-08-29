import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import compression from 'compression'
import express from 'express'
import cors from 'cors'
import healthHandler    from '../api/_handlers/health.js'
import settingsHandler  from '../api/_handlers/settings.js'
import telemetryHandler from '../api/_handlers/telemetry.js'
import authHandler      from '../api/_handlers/auth.js'
import signupHandler    from '../api/_handlers/signup.js'
import { callbackGoogleAuth, startGoogleAuth } from '../api/_handlers/google-auth.js'
import projectsHandler  from '../api/_handlers/projects.js'
import draftHandler     from '../api/_handlers/draft.js'
import svgHandler       from '../api/_handlers/svg.js'
import elementsHandler  from '../api/_handlers/elements.js'
import publishHandler   from '../api/_handlers/publish.js'
import runtimeHandler   from '../api/_handlers/runtime.js'
import runtimeSessionHandler from '../api/_handlers/runtime-session.js'
import runtimeTelemetryHandler from '../api/_handlers/runtime-telemetry.js'
import commandsHandler  from '../api/_handlers/commands.js'
import versionsHandler  from '../api/_handlers/versions.js'
import auditHandler     from '../api/_handlers/audit.js'
import membersHandler   from '../api/_handlers/members.js'
import connectorsHandler from '../api/_handlers/connectors.js'
import chartStorageHandler from '../api/_handlers/chart-storage.js'
import simulatorHandler from '../api/_handlers/simulator.js'
import simulationSequenceHandler from '../api/_handlers/simulation-sequence.js'
import { isDatabaseUnavailableError, requestId } from '../api/_lib/security.js'
import { allowedOrigins } from '../api/_lib/auth.js'
import { connectMongo, disconnectMongo } from '../api/_lib/mongo.js'
import { warmApiMongo } from './api-mongo-warmup.js'
import { RuntimeStreamHub } from './connectors/runtime-stream-hub.js'
import { ManagedConnectorWorker } from './connectors/managed-connector-worker.js'
import { RustShadowWorker } from './connectors/rust-shadow-worker.js'
import { CommandRetentionJanitor } from './connectors/command-retention-janitor.js'
import { createIsaacSessionAuthorizer } from './connectors/isaac-session-authorizer.js'

const app = express()
const safe = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next)
const production = process.env.NODE_ENV === 'production'
const connectorPlatformEnabled = process.env.CONNECTOR_PLATFORM_ENABLED === 'true'
const embeddedConnectorStream = connectorPlatformEnabled && process.env.CONNECTOR_STREAM_MODE === 'embedded'
const rustShadowEnabled = embeddedConnectorStream && process.env.SCADA_RUST_SHADOW_ENABLED === 'true'
const commandWakeEnabled = embeddedConnectorStream && process.env.CONNECTOR_COMMAND_WAKE_ENABLED !== 'false'
const isaacCanaryEnabled = rustShadowEnabled && process.env.SCADA_ISAAC_CANARY_ENABLED === 'true'
const isaacInternalToken = isaacCanaryEnabled ? randomBytes(32).toString('base64url') : ''
const PORT = process.env.PORT || 3001
const distDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
let managedConnectorWorker = null
let runtimeStreamHub = null
let rustShadowWorker = null
let commandRetentionJanitor = null
app.disable('x-powered-by')
app.set('trust proxy', 1)

// CORS only matters for local dev (vite:5173 → express:3001).
// In production, frontend + /api live on one Vercel origin → no CORS needed.
app.use(cors({ origin: production ? false : localCorsOrigins(), credentials: !production }))
app.use(compression())
app.use(express.json({ limit: '6mb' }))
app.use((req, res, next) => {
  const correlationId = requestId(req)
  req.correlationId = correlationId
  res.setHeader('X-Request-Id', correlationId)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', contentSecurityPolicy())
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
  }
  next()
})

if (isaacCanaryEnabled) {
  app.post('/internal/isaac/runtime-session', safe(createIsaacSessionAuthorizer({ internalToken: isaacInternalToken })))
}

// app.all() forwards every HTTP method to the same handler — the handler
// already switches on req.method, so we don't need app.get/app.post pairs.
app.all('/api/health',    safe(healthHandler))
app.all('/api/settings',  safe(settingsHandler))
app.all('/api/telemetry', safe(telemetryHandler))
app.all('/api/auth/google/start', safe(startGoogleAuth))
app.all('/api/auth/callback/google', safe(callbackGoogleAuth))
app.all('/api/auth',      safe(authHandler))
app.all('/api/signup',    safe(signupHandler))
app.all('/api/projects',  safe(projectsHandler))
app.all('/api/draft',     safe(draftHandler))
app.all('/api/svg',       safe(svgHandler))
app.all('/api/elements',  safe(elementsHandler))
app.all('/api/publish',   safe(publishHandler))
app.all('/api/runtime',   safe(runtimeHandler))
app.all('/api/runtime-session', safe((req, res) => runtimeSessionHandler(req, res, {
  resolveIsaacCanary: project => rustShadowWorker?.canary(project),
})))
app.all('/api/runtime-telemetry', safe(runtimeTelemetryHandler))
app.all('/api/commands',  safe((req, res) => commandsHandler(req, res, {
  onWorkerCommandAuthorized: commandWakeEnabled ? () => managedConnectorWorker?.requestCommandPoll() : null,
})))
app.all('/api/versions',  safe(versionsHandler))
app.all('/api/audit',     safe(auditHandler))
app.all('/api/members',   safe(membersHandler))
app.all('/api/connectors', safe(connectorsHandler))
app.all('/api/chart-storage', safe(chartStorageHandler))
app.all('/api/simulator', safe(simulatorHandler))
app.all('/api/simulation-sequence', safe(simulationSequenceHandler))

app.get(['/health/data-plane/live', '/health/data-plane/ready'], (req, res) => {
  const kind = req.path.endsWith('/ready') ? 'readiness' : 'liveness'
  const health = managedConnectorWorker?.health(kind) || {
    ok: false,
    status: embeddedConnectorStream ? 'starting' : 'disabled',
    mode: embeddedConnectorStream ? 'node-ipc' : 'standalone',
  }
  return res.status(kind === 'liveness' || health.ok ? 200 : 503).json({ ...health, check: kind, ts: Date.now() })
})
app.get('/health/data-plane/shadow', (req, res) => {
  const health = rustShadowWorker?.health() || {
    ok: false,
    status: rustShadowEnabled ? 'starting' : 'disabled',
    mode: 'rust-shadow',
    active: false,
  }
  return res.status(!rustShadowEnabled || health.ok ? 200 : 503).json({ ...health, enabled: rustShadowEnabled, ts: Date.now() })
})
app.get('/runtime-stream', (req, res) => res.status(426).json({ error: 'WebSocket upgrade required.' }))
app.get('/isaac-stream', (req, res) => res.status(426).json({ error: 'Isaac WebSocket upgrade required.' }))

if (shouldServeFrontend()) {
  const assetsDirectory = join(distDirectory, 'assets')
  app.use('/assets', express.static(assetsDirectory, { immutable: true, maxAge: '1y', fallthrough: false }))
  app.use(express.static(distDirectory, { etag: true, maxAge: 0, index: false }))
  app.get('*', (req, res, next) => {
    if (isServicePath(req.path)) return next()
    res.setHeader('Cache-Control', 'no-cache')
    return res.sendFile(join(distDirectory, 'index.html'))
  })
}

app.use((error, req, res, next) => {
  const correlationId = req.correlationId || requestId(req)
  console.error(JSON.stringify({
    level: 'error',
    event: 'api.request.failed',
    method: req.method,
    path: req.path,
    correlationId,
    errorName: String(error?.name || 'Error').slice(0, 80),
    errorCode: String(error?.code || 'INTERNAL').slice(0, 80),
  }))
  if (res.headersSent) return next(error)
  if (isDatabaseUnavailableError(error)) return res.status(503).json({ error: 'Database is temporarily unavailable.', code: 'DATABASE_UNAVAILABLE', correlationId })
  const statusCode = Number(error?.statusCode || error?.status)
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) return res.status(statusCode).json({ error: statusCode === 404 ? 'Not found.' : error.message })
  return res.status(500).json({ error: 'Internal server error.', correlationId })
})

const httpServer = createServer(app)
if (embeddedConnectorStream) {
  runtimeStreamHub = new RuntimeStreamHub({ httpServer })
  rustShadowWorker = rustShadowEnabled ? new RustShadowWorker({
    environment: {
      ...process.env,
      SCADA_ISAAC_GATEWAY_ENABLED: isaacCanaryEnabled ? 'true' : 'false',
      SCADA_ISAAC_INTERNAL_HOST: '127.0.0.1',
      SCADA_ISAAC_INTERNAL_PORT: String(PORT),
      SCADA_ISAAC_INTERNAL_TOKEN: isaacInternalToken,
      SCADA_ISAAC_ALLOWED_ORIGINS: allowedOrigins().join(','),
    },
  }) : null
  managedConnectorWorker = new ManagedConnectorWorker({ hub: runtimeStreamHub, observer: rustShadowWorker })
}
commandRetentionJanitor = new CommandRetentionJanitor()

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Express listening on http://localhost:${PORT}${shouldServeFrontend() ? ' with frontend assets' : ''}`)
  if (rustShadowWorker) rustShadowWorker.start()
  if (managedConnectorWorker) managedConnectorWorker.start()
  commandRetentionJanitor.start()
  void warmApiMongo({
    connect: connectMongo,
    shouldRetry: isDatabaseUnavailableError,
    onState: state => {
      if (state.phase === 'retrying-mongodb') {
        console.error('[Server] MongoDB startup connection unavailable; retry scheduled', {
          attempt: state.attempt,
          delayMs: state.delayMs,
          code: state.errorCode,
        })
      } else if (state.phase === 'ready') {
        console.log(`[Server] MongoDB ready after ${state.attempt} connection attempt${state.attempt === 1 ? '' : 's'}.`)
      } else if (state.phase === 'failed') {
        console.error('[Server] MongoDB warm-up failed', { attempt: state.attempt, code: state.errorCode })
      }
    },
  }).catch(() => {
    // Liveness remains available and readiness stays at HTTP 503. A transient
    // failure is retried above; configuration errors require operator action.
  })
})

let shuttingDown = false
const shutdown = async signal => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[Server] ${signal} received; stopping the self-hosted runtime.`)
  await commandRetentionJanitor?.close()
  await managedConnectorWorker?.close()
  await rustShadowWorker?.close()
  await runtimeStreamHub?.close()
  if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve))
  await disconnectMongo()
  console.log('[Server] Self-hosted runtime stopped cleanly.')
}
const handleShutdown = signal => {
  void shutdown(signal)
    .then(() => process.exit(0))
    .catch(error => {
      console.error('[Server] Self-hosted shutdown failed', { code: String(error?.code || error?.name || 'SHUTDOWN_FAILED').slice(0, 80) })
      process.exit(1)
    })
}
process.once('SIGINT', () => handleShutdown('SIGINT'))
process.once('SIGTERM', () => handleShutdown('SIGTERM'))

function localCorsOrigins() {
  const configured = String(process.env.APP_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean)
  return [...new Set([...configured, 'http://localhost:5173', 'http://127.0.0.1:5173'])]
}

function shouldServeFrontend() {
  const configured = String(process.env.SERVE_STATIC_FRONTEND || '').trim().toLowerCase()
  if (configured === 'false') return false
  if (configured !== 'true' && !production) return false
  return existsSync(join(distDirectory, 'index.html'))
}

function isServicePath(path) {
  return path === '/api' || path.startsWith('/api/') || path === '/health' || path.startsWith('/health/') || path === '/runtime-stream' || path === '/isaac-stream' || path.startsWith('/internal/isaac/')
}

function contentSecurityPolicy() {
  const streamOrigin = safeWebSocketOrigin(process.env.CONNECTOR_STREAM_PUBLIC_URL)
  const isaacOrigin = safeWebSocketOrigin(process.env.SCADA_ISAAC_STREAM_PUBLIC_URL)
  const connectSources = [...new Set(["'self'", ...(production ? [] : ['ws://localhost:3002', 'ws://127.0.0.1:3002', 'ws://localhost:3003', 'ws://127.0.0.1:3003']), ...(streamOrigin ? [streamOrigin] : []), ...(isaacOrigin ? [isaacOrigin] : [])])]
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; ')
}

function safeWebSocketOrigin(value) {
  try {
    const url = new URL(String(value || ''))
    return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null
  } catch {
    return null
  }
}
