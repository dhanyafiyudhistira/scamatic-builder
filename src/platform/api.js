export async function apiRequest(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const csrfToken = readCookie('scada_csrf')
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      'X-Request-ID': globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      ...options.headers,
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Request failed with status ${response.status}.`)
    error.status = response.status
    error.code = data.code
    error.issues = data.issues || []
    error.correlationId = data.correlationId || response.headers.get('X-Request-Id') || null
    error.result = data
    throw error
  }
  return data
}

function readCookie(name) {
  const prefix = `${name}=`
  const part = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix))
  return part ? decodeURIComponent(part.slice(prefix.length)) : ''
}

export function login(email, password) {
  return apiRequest('/api/auth', { method: 'POST', body: JSON.stringify({ email, password }) })
}

export function signup(account) {
  return apiRequest('/api/signup', { method: 'POST', body: JSON.stringify(account) })
}

export function logout() {
  return apiRequest('/api/auth', { method: 'DELETE' })
}
