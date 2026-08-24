const RUNTIME_METRICS_PARAMETER = 'metrics'
const RUNTIME_METRICS_ENABLED = 'enabled'
const RUNTIME_METRICS_DISABLED = 'disabled'

export function runtimeMetricsEnabled(search = '') {
  try {
    const input = String(search || '')
    const query = input.startsWith('?') ? input : `?${input}`
    return new URLSearchParams(query).get(RUNTIME_METRICS_PARAMETER) === RUNTIME_METRICS_ENABLED
  } catch {
    return false
  }
}

export function runtimeHrefWithMetrics(href, enabled) {
  const input = String(href || '').trim()
  if (!input) return ''
  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(input)
    const url = new URL(input, 'https://runtime.local')
    url.searchParams.set(RUNTIME_METRICS_PARAMETER, enabled ? RUNTIME_METRICS_ENABLED : RUNTIME_METRICS_DISABLED)
    return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`
  } catch {
    return input
  }
}
