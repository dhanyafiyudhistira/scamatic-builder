const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const EXPLICIT_BIND_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0', '::'])

export function resolveServerBindHost(value) {
  const configured = String(value || '').trim().toLowerCase()
  if (!configured || configured === 'localhost') return '127.0.0.1'
  if (!EXPLICIT_BIND_HOSTS.has(configured)) {
    throw new Error('SCAMATIC_BIND_HOST must be 127.0.0.1, ::1, 0.0.0.0, or ::.')
  }
  return configured
}

export function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase().split('%')[0]
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address === '::ffff:7f00:1'
}

export function canonicalLocalNavigationUrl(request = {}, configuredOrigin = process.env.SCAMATIC_CANONICAL_LOCAL_ORIGIN) {
  const origin = cleanCanonicalOrigin(configuredOrigin)
  if (!origin || !['GET', 'HEAD'].includes(String(request.method || '').toUpperCase())) return null

  const requestHost = String(request.host || '').trim().toLowerCase()
  const hostname = requestHost.startsWith('[')
    ? requestHost.slice(0, requestHost.indexOf(']') + 1)
    : requestHost.split(':')[0]
  if (hostname !== 'localhost') return null

  const fetchMode = String(request.fetchMode || '').trim().toLowerCase()
  if (fetchMode && fetchMode !== 'navigate') return null
  if (!String(request.accept || '').toLowerCase().includes('text/html')) return null

  const path = String(request.originalUrl || '/')
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) return null
  return new URL(path, origin).toString()
}

function cleanCanonicalOrigin(value) {
  if (!value) return null
  let url
  try { url = new URL(String(value).trim()) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
  return url.origin
}
