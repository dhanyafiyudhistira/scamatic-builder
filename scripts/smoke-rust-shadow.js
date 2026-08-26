import { RustShadowWorker } from '../server/connectors/rust-shadow-worker.js'

const silentLogger = { log() {}, warn() {}, error() {} }
const worker = new RustShadowWorker({ logger: silentLogger })

try {
  if (!worker.start()) throw new Error('Rust shadow binary is unavailable. Run npm run rust:build first.')
  const started = await waitFor(() => worker.health().ok, 5_000)
  if (!started) throw new Error('Rust shadow worker did not become ready.')

  const now = new Date().toISOString()
  worker.publishTelemetryBatch([
    { workspaceId: 'smoke-workspace', projectId: 'smoke-project', tagId: 'smoke-tag', value: 1, receivedAt: now },
    { workspaceId: 'smoke-workspace', projectId: 'smoke-project', tagId: 'smoke-tag', value: 2, receivedAt: now },
  ])
  worker.publishCommandStatus({ requestId: 'smoke-request', componentId: 'smoke-button', tagId: 'smoke-tag', status: 'dispatched' })
  await delay(100)

  const healthUrl = worker.health().healthUrl
  if (!healthUrl) throw new Error('Rust shadow worker did not publish a safe loopback health URL.')
  const readiness = await fetch(`${healthUrl}/health/ready`)
  const ready = await readiness.json()
  const metricsResponse = await fetch(`${healthUrl}/metrics`)
  const metrics = await metricsResponse.text()
  if (!readiness.ok || ready.active !== false) throw new Error('Rust shadow readiness contract is invalid.')
  if (!metrics.includes('scamatic_shadow_telemetry_events_total 1')) throw new Error('Rust shadow telemetry counter did not observe the coalesced event.')
  if (!metrics.includes('scamatic_shadow_command_events_total 1')) throw new Error('Rust shadow command counter did not observe the projected status.')

  console.log(JSON.stringify({
    ok: true,
    mode: ready.mode,
    active: ready.active,
    telemetryEvents: ready.telemetryEvents,
    commandEvents: ready.commandEvents,
    healthUrl,
  }))
} finally {
  await worker.close()
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(25)
  }
  return false
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
