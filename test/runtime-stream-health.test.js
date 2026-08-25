import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { RuntimeStreamHub } from '../server/connectors/runtime-stream-hub.js'

test('worker exposes distinct liveness and readiness on the stream port', async t => {
  let ready = false
  const hub = new RuntimeStreamHub({
    port: 0,
    healthProvider: kind => ({
      ok: kind === 'liveness' || ready,
      status: kind === 'liveness' ? 'alive' : ready ? 'ready' : 'not-ready',
      checks: { mongo: ready ? 'connected' : 'connecting' },
    }),
  })
  t.after(() => hub.close())
  await hub.ready()
  const { port } = hub.httpServer.address()

  const liveResponse = await fetch(`http://127.0.0.1:${port}/health/live`)
  assert.equal(liveResponse.status, 200)
  assert.equal((await liveResponse.json()).status, 'alive')

  const coldResponse = await fetch(`http://127.0.0.1:${port}/health/ready`)
  assert.equal(coldResponse.status, 503)
  assert.equal((await coldResponse.json()).checks.mongo, 'connecting')

  ready = true
  const readyResponse = await fetch(`http://127.0.0.1:${port}/health/ready`)
  assert.equal(readyResponse.status, 200)
  assert.equal((await readyResponse.json()).status, 'ready')
})

test('command status push is isolated to the matching actor, project, version, and capability', async t => {
  const hub = new RuntimeStreamHub({ port: 0 })
  t.after(async () => { hub.clients.clear(); await hub.close() })
  await hub.ready()
  const messages = { actor: [], other: [], viewer: [] }
  const client = (userId, capabilities, sink) => ({
    userId,
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    versionId: 'version-a',
    capabilities: new Set(capabilities),
    socket: { readyState: 1, send: frame => sink.push(JSON.parse(frame)), close() {}, terminate() {} },
  })
  hub.clients.add(client('operator-a', ['command.execute'], messages.actor))
  hub.clients.add(client('operator-b', ['command.execute'], messages.other))
  hub.clients.add(client('operator-a', ['runtime.view'], messages.viewer))

  const delivered = hub.publishCommand({
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    versionId: 'version-a',
    actorId: 'operator-a',
    requestId: 'request-1',
    componentId: 'button-a',
    tagId: 'tag-a',
    status: 'dispatched',
    payloadSummary: { token: 'must-not-leak' },
  })

  assert.equal(delivered, 1)
  assert.equal(messages.actor[0].type, 'command-status')
  assert.equal(messages.actor[0].command.status, 'dispatched')
  assert.equal(JSON.stringify(messages.actor[0]).includes('must-not-leak'), false)
  assert.equal(messages.other.length, 0)
  assert.equal(messages.viewer.length, 0)
})

test('runtime stream can share the Express HTTP server without owning its lifecycle', async t => {
  const httpServer = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('express')
  })
  const hub = new RuntimeStreamHub({ httpServer })
  t.after(async () => {
    if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve))
  })
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  await hub.ready()
  const { port } = httpServer.address()
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'express')

  await hub.close()
  assert.equal(httpServer.listening, true)
})
