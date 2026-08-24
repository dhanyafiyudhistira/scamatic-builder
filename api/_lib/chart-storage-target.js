import { lookup, resolveSrv } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isPrivateAddress } from './connector-target.js'

export function normalizeChartMongoUri(value, environment = process.env) {
  const raw = String(value || '').trim()
  let url
  try { url = new URL(raw) } catch { throw clientError('A valid MongoDB connection URI is required.') }
  if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol) || !url.hostname) throw clientError('Chart storage must use mongodb:// or mongodb+srv://.')
  if (!url.username || !url.password) throw clientError('MongoDB URI must include dedicated write credentials.')
  if (url.hash) throw clientError('MongoDB URI cannot contain a fragment.')
  if (environment.NODE_ENV === 'production' && url.protocol !== 'mongodb+srv:') {
    throw clientError('Production Chart storage must use a TLS-enabled mongodb+srv:// URI.')
  }
  const hostname = url.hostname.toLowerCase()
  const allowedHosts = configuredHosts('CHART_MONGO_ALLOWED_HOSTS', environment)
  if (environment.NODE_ENV === 'production' && (!allowedHosts.size || !allowedHosts.has(hostname))) {
    throw clientError('MongoDB host is not on CHART_MONGO_ALLOWED_HOSTS.')
  }
  return raw
}

export async function assertSafeChartMongoTarget(value, environment = process.env) {
  const normalized = normalizeChartMongoUri(value, environment)
  const url = new URL(normalized)
  const hostname = url.hostname.toLowerCase()
  let targetHosts
  let addresses
  try {
    targetHosts = url.protocol === 'mongodb+srv:'
      ? (await resolveSrv(`_mongodb._tcp.${hostname}`)).map(record => record.name)
      : [hostname]
    if (!targetHosts.length) throw new Error('No MongoDB targets returned.')
    addresses = (await Promise.all(targetHosts.map(async target => isIP(target)
      ? [{ address: target }]
      : lookup(target, { all: true, verbatim: true })))).flat()
  } catch {
    throw clientError('MongoDB host could not be resolved.')
  }
  if (!addresses.length) throw clientError('MongoDB host did not resolve to an address.')
  const privateAllowed = configuredHosts('CHART_MONGO_ALLOWED_PRIVATE_HOSTS', environment).has(hostname)
    || (environment.NODE_ENV !== 'production' && isLocalHostname(hostname))
  if (!privateAllowed && addresses.some(item => isPrivateAddress(item.address))) {
    throw clientError('MongoDB target resolves to a private or reserved network address.')
  }
  return normalized
}

export function chartStorageTargetLabel(value) {
  try {
    const host = new URL(String(value || '')).hostname
    const parts = host.split('.')
    if (parts.length < 2) return mask(parts[0] || 'mongodb')
    if (parts.length === 2) return `${mask(parts[0])}.${parts[1]}`
    return `${mask(parts[0])}.${parts.slice(-2).join('.')}`
  } catch {
    return 'MongoDB'
  }
}

function configuredHosts(name, environment) {
  return new Set(String(environment[name] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))
}
function isLocalHostname(value) { return ['localhost', '127.0.0.1', '::1'].includes(value) }
function mask(value) { return value.length <= 3 ? `${value[0] || 'm'}••` : `${value.slice(0, 3)}•••` }
function clientError(message) { return Object.assign(new Error(message), { statusCode: 400, code: 'CHART_STORAGE_TARGET_INVALID' }) }
