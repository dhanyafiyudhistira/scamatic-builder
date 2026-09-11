import { assertSafeConnectorTarget } from './connector-target.js'

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9-]{8,100}$/
const MAX_DEVICE_PAGE_SIZE = 50
const MAX_TELEMETRY_KEYS = 100

export async function listThingsBoardDevices({
  serverUrl,
  jwt,
  page = 0,
  pageSize = 20,
  textSearch = '',
  fetchImpl = globalThis.fetch,
  validateTarget = assertSafeConnectorTarget,
}) {
  const safePage = boundedInteger(page, 0, 10_000, 0)
  const safePageSize = boundedInteger(pageSize, 1, MAX_DEVICE_PAGE_SIZE, 20)
  const search = boundedText(textSearch, 120)
  const query = new URLSearchParams({
    page: String(safePage),
    pageSize: String(safePageSize),
    sortProperty: 'createdTime',
    sortOrder: 'DESC',
  })
  if (search) query.set('textSearch', search)
  const payload = await thingsBoardJson({ serverUrl, jwt, path: `/api/tenant/devices?${query}`, fetchImpl, validateTarget })
  const data = Array.isArray(payload?.data) ? payload.data.slice(0, safePageSize).map(publicDevice).filter(Boolean) : []
  return {
    devices: data,
    page: safePage,
    pageSize: safePageSize,
    totalElements: boundedInteger(payload?.totalElements, 0, 10_000_000, data.length),
    totalPages: boundedInteger(payload?.totalPages, 0, 500_000, data.length ? 1 : 0),
    hasNext: Boolean(payload?.hasNext),
  }
}

export async function getThingsBoardDevice({ serverUrl, jwt, deviceId, fetchImpl = globalThis.fetch, validateTarget = assertSafeConnectorTarget }) {
  const id = validDeviceId(deviceId)
  const payload = await thingsBoardJson({ serverUrl, jwt, path: `/api/device/${encodeURIComponent(id)}`, fetchImpl, validateTarget })
  const device = publicDevice(payload)
  if (!device || device.id !== id) throw catalogError('ThingsBoard returned an invalid device.', 'THINGSBOARD_DEVICE_INVALID', 502)
  return device
}

export async function discoverThingsBoardTelemetry({ serverUrl, jwt, deviceId, fetchImpl = globalThis.fetch, validateTarget = assertSafeConnectorTarget }) {
  const id = validDeviceId(deviceId)
  const rawKeys = await thingsBoardJson({
    serverUrl,
    jwt,
    path: `/api/plugins/telemetry/DEVICE/${encodeURIComponent(id)}/keys/timeseries`,
    fetchImpl,
    validateTarget,
  })
  const keys = [...new Set((Array.isArray(rawKeys) ? rawKeys : []).map(key => boundedText(key, 255)).filter(Boolean))].slice(0, MAX_TELEMETRY_KEYS)
  if (!keys.length) return { deviceId: id, keys: [], truncated: false }
  const query = new URLSearchParams({ keys: keys.join(','), useStrictDataTypes: 'true' })
  const latest = await thingsBoardJson({
    serverUrl,
    jwt,
    path: `/api/plugins/telemetry/DEVICE/${encodeURIComponent(id)}/values/timeseries?${query}`,
    fetchImpl,
    validateTarget,
  })
  return {
    deviceId: id,
    keys: keys.map(key => telemetryDescriptor(key, latest?.[key])),
    truncated: Array.isArray(rawKeys) && rawKeys.length > MAX_TELEMETRY_KEYS,
  }
}

async function thingsBoardJson({ serverUrl, jwt, path, fetchImpl, validateTarget }) {
  const target = await validateTarget(serverUrl)
  const response = await fetchImpl(`${target}${path}`, {
    headers: { 'X-Authorization': `Bearer ${jwt}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000),
  })
  if (!response?.ok) {
    const status = Number(response?.status) || 502
    throw catalogError(status === 401 ? 'ThingsBoard authentication was rejected.' : 'ThingsBoard catalog request failed.', status === 401 ? 'THINGSBOARD_UNAUTHORIZED' : `THINGSBOARD_HTTP_${status}`, status)
  }
  return response.json().catch(() => { throw catalogError('ThingsBoard returned invalid JSON.', 'THINGSBOARD_INVALID_RESPONSE', 502) })
}

function publicDevice(value) {
  const id = String(value?.id?.id || value?.id || '').trim()
  if (!DEVICE_ID_PATTERN.test(id)) return null
  return {
    id,
    name: boundedText(value?.name, 160) || id,
    label: boundedText(value?.label, 160),
    type: boundedText(value?.type, 120),
    createdTime: Number.isFinite(Number(value?.createdTime)) ? Number(value.createdTime) : null,
  }
}

function telemetryDescriptor(key, values) {
  const entry = Array.isArray(values) && values.length ? values[0] : null
  const sample = safeSample(entry?.value)
  return {
    key,
    dataType: inferTelemetryType(entry?.value),
    sample,
    timestamp: Number.isFinite(Number(entry?.ts)) ? Number(entry.ts) : null,
  }
}

export function inferTelemetryType(value) {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number' && Number.isFinite(value)) return 'number'
  const text = String(value ?? '').trim()
  if (/^(true|false)$/i.test(text)) return 'boolean'
  if (text && Number.isFinite(Number(text))) return 'number'
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text))) return 'datetime'
  return 'string'
}

function safeSample(value) {
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (value == null) return null
  return String(value).slice(0, 240)
}

function validDeviceId(value) {
  const id = String(value || '').trim()
  if (!DEVICE_ID_PATTERN.test(id)) throw catalogError('A valid ThingsBoard deviceId is required.', 'THINGSBOARD_DEVICE_ID_INVALID', 400)
  return id
}

function boundedText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

function catalogError(message, code, status) {
  const error = new Error(message)
  error.code = code
  error.status = status
  error.statusCode = status
  return error
}
