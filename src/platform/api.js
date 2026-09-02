import { clearDesktopAssetCache, desktopApiRequest, isDesktopApp } from './desktop.js'

export async function apiRequest(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  if (isDesktopApp()) {
    let response
    try {
      response = await abortable(desktopApiRequest({
        path,
        method,
        body: options.body ?? null,
        headers: {
          'X-Request-ID': globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
          ...options.headers,
        },
      }), options.signal)
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error(String(error || 'Desktop bridge request failed.'))
    }
    const data = response.body && typeof response.body === 'object' ? response.body : {}
    if (!response.ok) throw responseError(response.status, data, response.correlationId)
    return data
  }
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
  if (!response.ok) throw responseError(response.status, data, data.correlationId || response.headers.get('X-Request-Id'))
  return data
}

function responseError(status, data, correlationId = null) {
  const error = new Error(data.error || data.message || `Request failed with status ${status}.`)
  error.status = status
  error.code = data.code
  error.issues = data.issues || []
  error.correlationId = correlationId || null
  error.result = data
  return error
}

function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError')
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

export async function logout() {
  const result = await apiRequest('/api/auth', { method: 'DELETE' })
  clearDesktopAssetCache()
  return result
}
