import test from 'node:test'
import assert from 'node:assert/strict'
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
