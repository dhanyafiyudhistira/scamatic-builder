import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { ThingsBoardDriver } from '../server/connectors/thingsboard-driver.js'

test('ThingsBoard driver subscribes to selected keys and uses definitive two-way RPC', async t => {
  const token = 'test-token'
  const deviceId = '00000000-0000-0000-0000-000000000001'
  const server = http.createServer(async (req, res) => {
    if (req.url === `/api/plugins/rpc/twoway/${deviceId}` && req.headers['x-authorization'] === `Bearer ${token}`) {
      const body = await readJson(req)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ applied: body.params }))
    }
    res.writeHead(404); res.end()
  })
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.searchParams.get('token') !== token) return socket.destroy()
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws))
  })
  sockets.on('connection', socket => socket.once('message', raw => {
    const request = JSON.parse(String(raw))
    assert.equal(request.tsSubCmds[0].keys, 'Level_mix')
    socket.send(JSON.stringify({ errorCode: 0, data: { Level_mix: [[Date.now(), null]] } }))
    setTimeout(() => socket.send(JSON.stringify({ errorCode: 0, data: { Level_mix: [[Date.now(), '42.5']] } })), 5)
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const driver = new ThingsBoardDriver()
  await driver.connect({ config: { serverUrl: `http://127.0.0.1:${address.port}`, deviceId, rpcMode: 'two-way' }, secret: { jwt: token } })
  t.after(async () => {
    await driver.disconnect()
    for (const client of sockets.clients) client.terminate()
    await new Promise(resolve => sockets.close(resolve))
    await new Promise(resolve => server.close(resolve))
  })
  const subscription = driver.subscribe([{ id: 'level', path: 'Level_mix', dataType: 'number' }])
  const sample = await Promise.race([subscription.next(), new Promise((_, reject) => setTimeout(() => reject(new Error('Telemetry timeout')), 2000))])
  assert.equal(sample.value.path, 'Level_mix')
  assert.equal(sample.value.value, '42.5')
  const receipt = await driver.write({ method: 'setLevel', params: 55, timeoutMs: 2000, acknowledgment: { mode: 'two-way' } })
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.acknowledged, true)
  assert.deepEqual(receipt.result, { applied: 55 })
})

test('ThingsBoard driver preserves an explicit device-side RPC rejection', async t => {
  const token = 'test-token'
  const deviceId = '00000000-0000-0000-0000-000000000002'
  const server = http.createServer(async (req, res) => {
    if (req.url === `/api/plugins/rpc/twoway/${deviceId}`) {
      await readJson(req)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ accepted: false, error: 'Unsupported method' }))
    }
    res.writeHead(404); res.end()
  })
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws)))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const driver = new ThingsBoardDriver()
  await driver.connect({ config: { serverUrl: `http://127.0.0.1:${server.address().port}`, deviceId, rpcMode: 'two-way' }, secret: { jwt: token } })
  t.after(async () => {
    await driver.disconnect()
    for (const client of sockets.clients) client.terminate()
    await new Promise(resolve => sockets.close(resolve))
    await new Promise(resolve => server.close(resolve))
  })

  const receipt = await driver.write({ method: 'unsupported', params: true, timeoutMs: 2000, acknowledgment: { mode: 'two-way' } })
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.acknowledged, false)
  assert.equal(receipt.rejected, true)
  assert.equal(receipt.code, 'DEVICE_RPC_REJECTED')
})

function readJson(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } }); req.on('error', reject) }) }
