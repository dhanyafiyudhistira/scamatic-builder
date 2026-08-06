import { assertSafeConnectorTarget } from './connector-target.js'
import { coerceConnectorValue } from '../../shared/connector-contract.js'

const TELEMETRY_KEY = /^[a-zA-Z0-9_.:-]{1,120}$/

export async function sendThingsBoardRpc({
  config,
  jwt,
  method,
  params,
  timeoutMs = 5000,
  mode = 'two-way',
  fetchImpl = globalThis.fetch,
  validateTarget = assertSafeConnectorTarget,
}) {
  const serverUrl = await validateTarget(config?.serverUrl)
  const rpcMode = mode === 'two-way' ? 'twoway' : 'oneway'
  const response = await fetchImpl(`${serverUrl}/api/plugins/rpc/${rpcMode}/${encodeURIComponent(config?.deviceId || '')}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ method, params, timeout: timeoutMs, retries: 0 }),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (mode === 'two-way' && [408, 504].includes(response.status)) {
    return { accepted: true, acknowledged: false, timedOut: true, code: `HTTP_${response.status}` }
  }
  if (!response.ok) return { accepted: false, acknowledged: false, code: `HTTP_${response.status}` }
  if (mode !== 'two-way') return { accepted: true, acknowledged: false, code: 'ACCEPTED_BY_GATEWAY' }

  const result = await response.json().catch(() => null)
  if (result?.accepted === false || result?.ok === false) {
    return { accepted: true, acknowledged: false, rejected: true, code: 'DEVICE_RPC_REJECTED', result }
  }
  return { accepted: true, acknowledged: true, code: 'TWO_WAY_RPC_ACK', result }
}

export async function readThingsBoardLatestTelemetry({
  config,
  jwt,
  keys,
  timeoutMs = 4000,
  fetchImpl = globalThis.fetch,
  validateTarget = assertSafeConnectorTarget,
}) {
  const requestedKeys = [...new Set((keys || []).map(value => String(value || '').trim()).filter(Boolean))]
  if (!requestedKeys.length) return {}
  if (requestedKeys.length > 100 || requestedKeys.some(key => !TELEMETRY_KEY.test(key))) {
    throw Object.assign(new Error('ThingsBoard telemetry keys are invalid.'), { code: 'TELEMETRY_KEYS_INVALID' })
  }

  const serverUrl = await validateTarget(config?.serverUrl)
  const query = new URLSearchParams({ keys: requestedKeys.join(',') })
  const response = await fetchImpl(`${serverUrl}/api/plugins/telemetry/DEVICE/${encodeURIComponent(config?.deviceId || '')}/values/timeseries?${query}`, {
    headers: { 'X-Authorization': `Bearer ${jwt}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw Object.assign(new Error('ThingsBoard telemetry request failed.'), {
      code: `HTTP_${response.status}`,
      status: response.status,
    })
  }
  const payload = await response.json()
  return Object.fromEntries(requestedKeys.flatMap(key => {
    const samples = payload?.[key]
    if (!Array.isArray(samples) || !samples.length) return []
    const sample = samples[0]
    const timestamp = Number(sample?.ts)
    if (!Number.isFinite(timestamp) || sample?.value == null) return []
    return [[key, { timestamp, value: sample.value }]]
  }))
}

export async function waitForThingsBoardFeedback({
  config,
  jwt,
  key,
  dataType,
  expectedValue,
  timeoutMs,
  afterTimestamp = 0,
  pollIntervalMs = 250,
  readLatest = readThingsBoardLatestTelemetry,
}) {
  const deadline = Date.now() + timeoutMs
  let lastSample = null
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const latest = await readLatest({
      config,
      jwt,
      keys: [key],
      timeoutMs: Math.min(4000, remaining),
    })
    const sample = latest[key]
    if (sample) {
      lastSample = sample
      const actual = coerceConnectorValue(sample.value, dataType)
      const expected = coerceConnectorValue(expectedValue, dataType)
      if (sample.timestamp >= afterTimestamp && Object.is(actual, expected)) return { matched: true, sample: { ...sample, value: actual } }
    }
    const delayMs = Math.min(pollIntervalMs, deadline - Date.now())
    if (delayMs > 0) await delay(delayMs)
  }
  return { matched: false, sample: lastSample }
}

export function telemetryEventFromLatest({ workspaceId, projectId, sourceId, tag, sample, receivedAt = Date.now() }) {
  const timestamp = Number(sample?.timestamp)
  if (!Number.isFinite(timestamp)) return null
  return {
    workspaceId,
    projectId,
    sourceId,
    tagId: tag.id,
    value: coerceConnectorValue(sample.value, tag.dataType),
    dataType: tag.dataType,
    sourceTimestamp: new Date(timestamp).toISOString(),
    receivedAt: new Date(receivedAt).toISOString(),
    quality: 'good',
    sequence: timestamp,
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
