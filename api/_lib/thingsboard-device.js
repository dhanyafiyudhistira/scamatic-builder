import { assertSafeConnectorTarget } from './connector-target.js'

export async function publishDeviceTelemetry({ serverUrl, deviceToken, values, fetchImpl = fetch, timeoutMs = 8000 }) {
  return deviceRequest({ serverUrl, deviceToken, resource: 'telemetry', method: 'POST', body: values, fetchImpl, timeoutMs })
}

export function timestampedDeviceTelemetry(values, timestamp = Date.now(), { now = Date.now(), maxSkewMs = 5 * 60_000 } = {}) {
  const ts = Number(timestamp)
  if (!Number.isSafeInteger(ts) || ts <= 0) throw bridgeError('Telemetry timestamp is invalid.', 'SIMULATION_TIMESTAMP_INVALID')
  if (Math.abs(ts - Number(now)) > maxSkewMs) throw bridgeError('Telemetry timestamp is outside the accepted clock window.', 'SIMULATION_TIMESTAMP_INVALID')
  return { ts, values }
}

export async function pollDeviceRpc({ serverUrl, deviceToken, fetchImpl = fetch, timeoutMs = 22_000, longPollMs = 18_000 }) {
  const response = await deviceRequest({
    serverUrl,
    deviceToken,
    resource: `rpc?timeout=${bounded(longPollMs, 1000, 20_000)}`,
    method: 'GET',
    fetchImpl,
    timeoutMs,
    allowEmpty: true,
    idleStatusCodes: [408],
  })
  if (!response) return null
  if ((typeof response.id !== 'number' && typeof response.id !== 'string') || typeof response.method !== 'string') {
    throw bridgeError('ThingsBoard returned an invalid RPC request.', 'SIMULATION_RPC_INVALID')
  }
  return { id: response.id, method: response.method, params: response.params }
}

export async function respondDeviceRpc({ serverUrl, deviceToken, requestId, payload, fetchImpl = fetch, timeoutMs = 8000 }) {
  const id = String(requestId || '')
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw bridgeError('RPC request ID is invalid.', 'SIMULATION_RPC_ID_INVALID')
  await deviceRequest({ serverUrl, deviceToken, resource: `rpc/${id}`, method: 'POST', body: payload || {}, fetchImpl, timeoutMs })
  return { success: true }
}

async function deviceRequest({ serverUrl, deviceToken, resource, method, body, fetchImpl, timeoutMs, allowEmpty = false, idleStatusCodes = [] }) {
  const token = String(deviceToken || '').trim()
  if (token.length < 8 || token.length > 512 || /[\s/]/.test(token)) throw bridgeError('ThingsBoard device token is invalid.', 'SIMULATION_DEVICE_TOKEN_INVALID')
  const origin = await assertSafeConnectorTarget(serverUrl)
  const response = await fetchImpl(`${origin}/api/v1/${encodeURIComponent(token)}/${resource}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (idleStatusCodes.includes(response.status)) {
    await response.text()
    return null
  }
  if (!response.ok) throw bridgeError(`ThingsBoard device transport returned HTTP ${response.status}.`, `HTTP_${response.status}`)
  const text = await response.text()
  if (!text.trim()) return allowEmpty ? null : {}
  try { return JSON.parse(text) } catch { throw bridgeError('ThingsBoard returned malformed JSON.', 'SIMULATION_UPSTREAM_INVALID') }
}

function bounded(value, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min
}

function bridgeError(message, code) {
  return Object.assign(new Error(message), { code })
}
