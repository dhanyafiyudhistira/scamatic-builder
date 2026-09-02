const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

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
