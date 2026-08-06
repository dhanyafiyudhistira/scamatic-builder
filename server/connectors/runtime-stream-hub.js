import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { allowedOrigins, isAuthSessionRecordActive } from '../../api/_lib/auth.js'
import { AuthSession, Project, ProjectVersion, RuntimeSession, RuntimeStreamSession } from '../../api/_lib/models.js'

export class RuntimeStreamHub {
  constructor({ port = 3002, path = '/runtime-stream', flushMs = 100, revalidateMs = 5_000, allowedOriginList = allowedOrigins(), healthProvider = defaultHealth } = {}) {
    this.allowedOriginList = allowedOriginList
    this.healthProvider = healthProvider
    this.httpServer = createServer((request, response) => this.#handleHttp(request, response))
    this.server = new WebSocketServer({
      server: this.httpServer,
      path,
      verifyClient: info => isRuntimeStreamOriginAllowed(info.origin || info.req.headers.origin, this.allowedOriginList),
    })
    this.clients = new Set()
    this.flushMs = flushMs
    this.revalidateMs = revalidateMs
    this.server.on('connection', (socket, request) => this.#authenticate(socket, request))
    this.listening = new Promise((resolve, reject) => {
      const onError = error => { this.httpServer.off('listening', onListening); reject(error) }
      const onListening = () => { this.httpServer.off('error', onError); resolve() }
      this.httpServer.once('error', onError)
      this.httpServer.once('listening', onListening)
      this.httpServer.listen(port, '0.0.0.0')
    })
  }

  ready() {
    return this.listening
  }

  #handleHttp(request, response) {
    const path = new URL(request.url || '/', 'http://worker.local').pathname
    if (request.method !== 'GET' || !['/health/live', '/health/ready'].includes(path)) {
      response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ ok: false, status: 'not-found' }))
      return
    }
    const kind = path.endsWith('/ready') ? 'readiness' : 'liveness'
    const health = this.healthProvider(kind)
    const ok = kind === 'liveness' || health.ok === true
    response.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ ...health, ok, check: kind, ts: Date.now() }))
  }

  async #authenticate(socket, request) {
    try {
      const url = new URL(request.url, 'http://worker.local')
      const ticket = url.searchParams.get('ticket') || ''
      const session = await RuntimeStreamSession.findOneAndUpdate(
        { _id: digest(ticket), revokedAt: null, consumedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { consumedAt: new Date() } },
        { new: true }
      ).lean()
      if (!session) return socket.close(4401, 'Invalid stream ticket')
      const runtimeSession = await RuntimeSession.findOne({ _id: session.runtimeSessionId, userId: session.userId, workspaceId: session.workspaceId, projectId: session.projectId, versionId: session.versionId, revokedAt: null, expiresAt: { $gt: new Date() } }).lean()
      if (!runtimeSession) return socket.close(4401, 'Runtime session expired')
      const authSession = await AuthSession.findOne({ _id: runtimeSession.authSessionId, userId: session.userId, workspaceId: session.workspaceId, revokedAt: null, expiresAt: { $gt: new Date() } }).lean()
      if (!isAuthSessionRecordActive(authSession)) return socket.close(4401, 'Authentication session expired')
      const project = await Project.findOne({ _id: session.projectId, workspaceId: session.workspaceId, activeVersionId: session.versionId }).lean()
      const version = project && await ProjectVersion.findById(session.versionId).lean()
      if (!project || !version) return socket.close(4403, 'Stale stream ticket')
      const allowedTags = new Set((version.schema?.tags || []).map(tag => tag.id))
      const client = { socket, workspaceId: session.workspaceId, projectId: session.projectId, versionId: session.versionId, runtimeSessionId: runtimeSession._id, authSessionId: authSession._id, allowedTags, pending: new Map(), timer: null, validating: false }
      this.clients.add(client)
      const sessionTimer = setTimeout(() => socket.close(4401, 'Runtime session expired'), Math.max(1, new Date(runtimeSession.expiresAt).getTime() - Date.now()))
      const validationTimer = setInterval(() => this.#revalidate(client), this.revalidateMs)
      validationTimer.unref?.()
      socket.on('close', () => { clearTimeout(client.timer); clearTimeout(sessionTimer); clearInterval(validationTimer); this.clients.delete(client) })
      socket.send(JSON.stringify({ type: 'ready', projectId: session.projectId, versionId: session.versionId, expiresAt: runtimeSession.expiresAt }))
    } catch {
      socket.close(1011, 'Stream authentication failed')
    }
  }

  async #revalidate(client) {
    if (client.validating || client.socket.readyState !== 1) return
    client.validating = true
    try {
      const now = new Date()
      const [runtimeSession, authSession, project] = await Promise.all([
        RuntimeSession.findOne({ _id: client.runtimeSessionId, authSessionId: client.authSessionId, revokedAt: null, expiresAt: { $gt: now } }).lean(),
        AuthSession.findOne({ _id: client.authSessionId, revokedAt: null, expiresAt: { $gt: now } }).lean(),
        Project.findOne({ _id: client.projectId, workspaceId: client.workspaceId, activeVersionId: client.versionId }).select({ _id: 1 }).lean(),
      ])
      if (!runtimeSession || !isAuthSessionRecordActive(authSession, now) || !project) client.socket.close(4401, 'Session revoked')
    } catch {
      client.socket.close(1011, 'Session validation failed')
    } finally {
      client.validating = false
    }
  }

  publish(event) {
    for (const client of this.clients) {
      if (client.workspaceId !== event.workspaceId || client.projectId !== event.projectId || !client.allowedTags.has(event.tagId) || client.socket.readyState !== 1) continue
      client.pending.set(event.tagId, event)
      if (!client.timer) client.timer = setTimeout(() => this.#flush(client), this.flushMs)
    }
  }

  #flush(client) {
    client.timer = null
    if (client.socket.readyState !== 1 || !client.pending.size) return
    const events = [...client.pending.values()]
    client.pending.clear()
    client.socket.send(JSON.stringify({ type: 'tag-batch', events }))
  }

  async close() {
    for (const client of this.clients) client.socket.terminate()
    await new Promise(resolve => this.server.close(resolve))
    if (this.httpServer.listening) await new Promise(resolve => this.httpServer.close(resolve))
  }
}

function digest(value) { return createHash('sha256').update(String(value)).digest('hex') }
function defaultHealth(kind) { return { ok: kind === 'liveness', status: kind === 'liveness' ? 'alive' : 'not-ready' } }

export function isRuntimeStreamOriginAllowed(origin, originList = allowedOrigins(), production = process.env.NODE_ENV === 'production') {
  const value = String(origin || '')
  if (!value) return !production
  return originList.includes(value)
}
