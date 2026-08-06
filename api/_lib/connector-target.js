import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export function normalizeConnectorServerUrl(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { throw clientError('A valid ThingsBoard serverUrl is required.') }
  if (url.username || url.password || url.search || url.hash) throw clientError('ThingsBoard serverUrl cannot contain credentials, query parameters, or fragments.')

  const hostname = url.hostname.toLowerCase()
  const local = isLocalHostname(hostname)
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local && url.protocol === 'http:')) {
    throw clientError('ThingsBoard serverUrl must use HTTPS.')
  }
  const allowedHosts = configuredHosts('CONNECTOR_ALLOWED_HOSTS')
  if (process.env.NODE_ENV === 'production' && (!allowedHosts.size || !allowedHosts.has(hostname))) {
    throw clientError('ThingsBoard host is not on CONNECTOR_ALLOWED_HOSTS.')
  }
  return url.toString().replace(/\/$/, '')
}

export async function assertSafeConnectorTarget(value) {
  const normalized = normalizeConnectorServerUrl(value)
  const url = new URL(normalized)
  const hostname = url.hostname.toLowerCase()
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length) throw clientError('ThingsBoard host did not resolve to an address.')

  const privateAllowed = configuredHosts('CONNECTOR_ALLOWED_PRIVATE_HOSTS').has(hostname)
    || (process.env.NODE_ENV !== 'production' && isLocalHostname(hostname))
  if (!privateAllowed && addresses.some(item => isPrivateAddress(item.address))) {
    throw clientError('ThingsBoard host resolves to a private or reserved network address.')
  }
  return normalized
}

export function isPrivateAddress(value) {
  const address = String(value || '').toLowerCase().split('%')[0]
  if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice(7))
  if (address.includes(':')) {
    return address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd') || /^fe[89ab]/.test(address)
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
}

function configuredHosts(name) {
  return new Set(String(process.env[name] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))
}
function isLocalHostname(value) { return ['localhost', '127.0.0.1', '::1'].includes(value) }
function clientError(message) { return Object.assign(new Error(message), { statusCode: 400 }) }
