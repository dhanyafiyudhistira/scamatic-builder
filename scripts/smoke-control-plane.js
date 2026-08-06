import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const cwd = new URL('..', import.meta.url)
const port = Number(process.env.CONTROL_PLANE_SMOKE_PORT || 3101)
const server = spawn(process.execPath, ['server/index.js'], { cwd, env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let serverError = ''
server.stderr.on('data', chunk => { serverError += String(chunk).slice(0, 2000) })

try {
  await waitForServer()
  const health = await fetch(`http://127.0.0.1:${port}/api/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).ok, true)

  const connectorWithoutSession = await fetch(`http://127.0.0.1:${port}/api/connectors?projectId=smoke-project&environmentRef=staging`)
  assert.equal(connectorWithoutSession.status, 401, 'Connector route must exist and require authentication.')
  const connectorError = await connectorWithoutSession.json()
  assert.equal(connectorError.error, 'Authentication required.')

  console.log(JSON.stringify({ ok: true, health: 200, connectorRoute: 401, databaseMutated: false }))
} finally {
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])
}

async function waitForServer() {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(serverError.trim() || 'Control plane exited before becoming ready.')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch { /* Retry until the bounded deadline. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Control plane did not become ready within 6 seconds.')
}
