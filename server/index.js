import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import healthHandler    from '../api/_handlers/health.js'
import settingsHandler  from '../api/_handlers/settings.js'
import telemetryHandler from '../api/_handlers/telemetry.js'
import authHandler      from '../api/_handlers/auth.js'
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
import { connectMongo } from '../api/_lib/mongo.js'
import { warmApiMongo } from './api-mongo-warmup.js'

const app = express()
const safe = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next)
const production = process.env.NODE_ENV === 'production'
app.disable('x-powered-by')
app.set('trust proxy', 1)

// CORS only matters for local dev (vite:5173 → express:3001).
// In production, frontend + /api live on one Vercel origin → no CORS needed.
app.use(cors({ origin: production ? false : localCorsOrigins(), credentials: !production }))
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

// app.all() forwards every HTTP method to the same handler — the handler
// already switches on req.method, so we don't need app.get/app.post pairs.
app.all('/api/health',    safe(healthHandler))
app.all('/api/settings',  safe(settingsHandler))
app.all('/api/telemetry', safe(telemetryHandler))
app.all('/api/auth',      safe(authHandler))
app.all('/api/projects',  safe(projectsHandler))
app.all('/api/draft',     safe(draftHandler))
app.all('/api/svg',       safe(svgHandler))
app.all('/api/elements',  safe(elementsHandler))
app.all('/api/publish',   safe(publishHandler))
app.all('/api/runtime',   safe(runtimeHandler))
app.all('/api/runtime-session', safe(runtimeSessionHandler))
app.all('/api/runtime-telemetry', safe(runtimeTelemetryHandler))
app.all('/api/commands',  safe(commandsHandler))
app.all('/api/versions',  safe(versionsHandler))
app.all('/api/audit',     safe(auditHandler))
app.all('/api/members',   safe(membersHandler))
app.all('/api/connectors', safe(connectorsHandler))
app.all('/api/chart-storage', safe(chartStorageHandler))
app.all('/api/simulator', safe(simulatorHandler))
app.all('/api/simulation-sequence', safe(simulationSequenceHandler))

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
  if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message })
  return res.status(500).json({ error: 'Internal server error.', correlationId })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Local dev API on http://localhost:${PORT}`)
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

function localCorsOrigins() {
  const configured = String(process.env.APP_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean)
  return [...new Set([...configured, 'http://localhost:5173', 'http://127.0.0.1:5173'])]
}

function contentSecurityPolicy() {
  const streamOrigin = safeWebSocketOrigin(process.env.CONNECTOR_STREAM_PUBLIC_URL)
  const connectSources = ["'self'", ...(production ? [] : ['ws://localhost:3002', 'ws://127.0.0.1:3002']), ...(streamOrigin ? [streamOrigin] : [])]
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
