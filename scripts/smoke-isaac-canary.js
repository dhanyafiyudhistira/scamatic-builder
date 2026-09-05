import { createServer } from 'node:http'
import WebSocket from 'ws'
import { RustShadowWorker } from '../server/connectors/rust-shadow-worker.js'

const origin = 'http://localhost:5173'
const internalToken = 'isaac-smoke-internal-token-0123456789abcdef'
const streamTicket = 'isaac_smoke_ticket_0123456789abcdef'
const session = {
  runtimeSessionId: 'a'.repeat(64),
  userId: 'smoke-user',
  workspaceId: 'smoke-workspace',
  projectId: 'smoke-project',
  versionId: 'smoke-version',
  capabilities: ['runtime.view', 'command.execute'],
  allowedTagIds: ['smoke-tag'],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}
let sessionValid = true
let authorizationCalls = 0
let revalidationCalls = 0
let socket = null
const authorizer = createInternalAuthorizer()
const gatewayPort = await reserveLoopbackPort()
const worker = new RustShadowWorker({
  environment: {
    ...process.env,
    SCADA_ISAAC_GATEWAY_ENABLED: 'true',
    SCADA_ISAAC_CANARY_ENABLED: 'true',
    SCADA_ISAAC_STREAM_BIND: `127.0.0.1:${gatewayPort}`,
    SCADA_ISAAC_STREAM_PUBLIC_URL: `ws://127.0.0.1:${gatewayPort}/isaac-stream`,
    SCADA_ISAAC_INTERNAL_HOST: '127.0.0.1',
    SCADA_ISAAC_INTERNAL_TOKEN: internalToken,
    SCADA_ISAAC_ALLOWED_ORIGINS: origin,
    SCADA_ISAAC_REVALIDATE_MS: '1000',
  },
  logger: { log() {}, warn() {}, error() {} },
})

try {
  const internalAddress = await listen(authorizer)
  worker.environment.SCADA_ISAAC_INTERNAL_PORT = String(internalAddress.port)
  if (!worker.start()) throw new Error('Rust binary is unavailable. Run npm run rust:build first.')
  if (!await waitFor(() => worker.health().ok && worker.health().gatewayReady === true, 5_000)) {
    throw new Error('Isaac gateway did not become ready.')
  }

  const messages = []
  const healthUrl = worker.health().healthUrl
  socket = new WebSocket(`${healthUrl.replace(/^http:/, 'ws:')}/isaac-stream?ticket=${streamTicket}`, { origin })
  socket.on('message', data => {
    try { messages.push(JSON.parse(String(data))) } catch { /* The smoke test ignores malformed frames. */ }
  })
  await waitForSocketOpen(socket, 3_000)
  if (!await waitFor(() => messages.some(message => message.type === 'ready' && message.engine === 'isaac'), 3_000)) {
    throw new Error('Isaac socket did not publish its authenticated ready frame.')
  }

  const timestamp = new Date().toISOString()
  worker.publishTelemetryBatch([
    { workspaceId: session.workspaceId, projectId: session.projectId, tagId: 'smoke-tag', value: 42, quality: 'good', receivedAt: timestamp },
    { workspaceId: session.workspaceId, projectId: session.projectId, tagId: 'forbidden-tag', value: 99, quality: 'good', receivedAt: timestamp },
    { workspaceId: session.workspaceId, projectId: 'foreign-project', tagId: 'smoke-tag', value: 100, quality: 'good', receivedAt: timestamp },
  ])
  worker.publishCommandStatus({
    requestId: 'smoke-request',
    componentId: 'smoke-button',
    tagId: 'smoke-tag',
    status: 'acknowledged',
    actorId: session.userId,
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    versionId: session.versionId,
  })
  if (!await waitFor(() => messages.some(message => message.type === 'tag-batch') && messages.some(message => message.type === 'command-status'), 3_000)) {
    throw new Error('Isaac did not deliver scoped telemetry and command status.')
  }
  const telemetry = messages.find(message => message.type === 'tag-batch')
  if (telemetry.events.length !== 1 || telemetry.events[0].tagId !== 'smoke-tag' || telemetry.events[0].value !== 42) {
    throw new Error(`Isaac scope filter failed: ${JSON.stringify(telemetry)}`)
  }
  const commandStatus = messages.find(message => message.type === 'command-status')
  if (commandStatus.command?.requestId !== 'smoke-request' || commandStatus.command?.status !== 'acknowledged') {
    throw new Error(`Isaac command-status wire format changed: ${JSON.stringify(commandStatus)}`)
  }

  const closed = waitForSocketClose(socket, 4_000)
  sessionValid = false
  const close = await closed
  if (close.code !== 4401) throw new Error(`Expected revoked session close code 4401, received ${close.code}.`)
  const health = worker.health()
  if (authorizationCalls !== 1 || revalidationCalls < 1 || health.gatewayDeliveredEvents < 2 || health.gatewayCommandEncodedBytes < 1) {
    throw new Error(`Isaac lifecycle counters are invalid: ${JSON.stringify({ authorizationCalls, revalidationCalls, health })}`)
  }

  console.log(JSON.stringify({
    ok: true,
    mode: health.mode,
    active: health.active,
    gatewayReady: health.gatewayReady,
    publicUrlReady: health.publicUrlReady,
    deliveredEvents: health.gatewayDeliveredEvents,
    commandEncodedBytes: health.gatewayCommandEncodedBytes,
    authorizationCalls,
    revalidationCalls,
    revokedCloseCode: close.code,
  }))
} finally {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.terminate()
  await worker.close()
  await closeServer(authorizer)
}

function createInternalAuthorizer() {
  return createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* Rejected below. */ }
      const trusted = request.method === 'POST'
        && request.url === '/internal/isaac/runtime-session'
        && request.headers['x-isaac-internal-token'] === internalToken
      let accepted = false
      if (trusted && body?.action === 'authorize' && body.ticket === streamTicket) {
        authorizationCalls += 1
        accepted = sessionValid
      } else if (trusted && body?.action === 'revalidate' && body.runtimeSessionId === session.runtimeSessionId) {
        revalidationCalls += 1
        accepted = sessionValid
      }
      const payload = JSON.stringify(accepted ? { ok: true, session } : { ok: false })
      response.writeHead(accepted ? 200 : 401, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
        Connection: 'close',
      })
      response.end(payload)
    })
  })
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address())
    })
  })
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise(resolve => server.close(resolve))
}

async function reserveLoopbackPort() {
  const server = createServer()
  const address = await listen(server)
  await closeServer(server)
  return address.port
}

function waitForSocketOpen(webSocket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Isaac socket open.')), timeoutMs)
    webSocket.once('open', () => { clearTimeout(timer); resolve() })
    webSocket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

function waitForSocketClose(webSocket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Isaac session revocation.')), timeoutMs)
    webSocket.once('close', (code, reason) => {
      clearTimeout(timer)
      resolve({ code, reason: String(reason) })
    })
  })
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}
