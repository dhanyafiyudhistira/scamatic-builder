import 'dotenv/config'
import http from 'node:http'
import { WebSocketServer } from 'ws'

const port = Number(process.env.THINGSBOARD_SIMULATOR_PORT || 8090)
const token = process.env.THINGSBOARD_SIMULATOR_TOKEN || 'staging-simulator-token-change-me'
const deviceId = process.env.THINGSBOARD_SIMULATOR_DEVICE_ID || '00000000-0000-0000-0000-000000000001'
const sockets = new Map()

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' })
  if (req.method === 'GET' && req.url === '/api/auth/user') return json(res, 200, { id: { id: 'simulator-user' }, authority: 'TENANT_ADMIN' })
  const rpc = req.url?.match(/^\/api\/plugins\/rpc\/(oneway|twoway)\/([^/?]+)$/)
  if (req.method === 'POST' && rpc) {
    if (rpc[2] !== deviceId) return json(res, 404, { error: 'Device not found' })
    const body = await readJson(req).catch(() => null)
    if (!body?.method) return json(res, 400, { error: 'method is required' })
    broadcastFeedback(body.params)
    return rpc[1] === 'twoway' ? json(res, 200, { ok: true, method: body.method, value: body.params }) : json(res, 200, {})
  }
  json(res, 404, { error: 'Not found' })
})

const webSockets = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://simulator.local')
  if (url.pathname !== '/api/ws/plugins/telemetry' || url.searchParams.get('token') !== token) return socket.destroy()
  webSockets.handleUpgrade(req, socket, head, ws => webSockets.emit('connection', ws, req))
})

webSockets.on('connection', socket => {
  sockets.set(socket, { keys: ['Level_mix'] })
  socket.on('message', raw => {
    try {
      const request = JSON.parse(String(raw))
      const keys = String(request.tsSubCmds?.[0]?.keys || 'Level_mix').split(',').filter(Boolean)
      sockets.set(socket, { keys })
    } catch { socket.send(JSON.stringify({ errorCode: 400, errorMsg: 'Malformed subscription' })) }
  })
  socket.on('close', () => sockets.delete(socket))
})

let tick = 0
const timer = setInterval(() => {
  tick += 1
  const timestamp = Date.now()
  for (const [socket, subscription] of sockets) {
    if (socket.readyState !== 1) continue
    const data = Object.fromEntries(subscription.keys.map(key => [key, [[timestamp, simulatedValue(key, tick)]]]))
    socket.send(JSON.stringify({ subscriptionId: 1, errorCode: 0, data }))
  }
}, 1000)

server.listen(port, '127.0.0.1', () => {
  console.log(`[ThingsBoardSimulator] http://127.0.0.1:${port} device=${deviceId}`)
  console.log('[ThingsBoardSimulator] token is intentionally not printed; read THINGSBOARD_SIMULATOR_TOKEN.')
})

function authorized(req) { return req.headers['x-authorization'] === `Bearer ${token}` }
function simulatedValue(key, currentTick) {
  if (/valve|motor|running|feedback/i.test(key)) return currentTick % 2 ? 'true' : 'false'
  return String(Math.round((50 + Math.sin(currentTick / 5) * 25) * 10) / 10)
}
function broadcastFeedback(value) {
  const timestamp = Date.now()
  for (const [socket, subscription] of sockets) {
    const feedbackKeys = subscription.keys.filter(key => /feedback|ack/i.test(key))
    if (socket.readyState === 1 && feedbackKeys.length) socket.send(JSON.stringify({ subscriptionId: 1, errorCode: 0, data: Object.fromEntries(feedbackKeys.map(key => [key, [[timestamp, value]]])) }))
  }
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
function readJson(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy() }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch (error) { reject(error) } }); req.on('error', reject) }) }

process.once('SIGINT', () => { clearInterval(timer); webSockets.close(); server.close(() => process.exit(0)) })
