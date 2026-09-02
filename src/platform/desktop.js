import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { hydrateConnectedDesignAsset, hydrateConnectedDesignAssets } from '../../shared/design-asset-source.js'

const desktopAssetCache = new Map()

export function isDesktopApp() {
  return isTauri()
}

export function desktopInfo() {
  return invoke('desktop_info')
}

export function desktopApiRequest({ path, method = 'GET', body = null, headers = {} }) {
  return invoke('desktop_api_request', {
    request: {
      path,
      method,
      body,
      headers: Object.fromEntries(Object.entries(headers || {}).map(([name, value]) => [name, String(value)])),
    },
  })
}

export function resolveDesignAsset(asset) {
  if (!isDesktopApp()) return Promise.resolve(asset)
  return hydrateConnectedDesignAsset(asset, loadDesktopAssetSource)
}

export function resolveDesignAssets(assets) {
  if (!isDesktopApp()) return Promise.resolve(assets || {})
  return hydrateConnectedDesignAssets(assets, loadDesktopAssetSource)
}

export function clearDesktopAssetCache() {
  desktopAssetCache.clear()
}

export async function connectRuntimeStream({ url, ticket, onOpen, onMessage, onError, onClose }) {
  if (!isDesktopApp()) {
    const socket = new WebSocket(streamUrl(url, ticket))
    socket.addEventListener('open', () => onOpen?.())
    socket.addEventListener('message', event => onMessage?.(event.data))
    socket.addEventListener('error', () => onError?.('Runtime stream failed.'))
    socket.addEventListener('close', event => onClose?.({ code: event.code, reason: event.reason }))
    return () => socket.close()
  }

  const events = new Channel()
  events.onmessage = event => {
    if (event?.type === 'open') onOpen?.()
    else if (event?.type === 'message') onMessage?.(event.data)
    else if (event?.type === 'error') onError?.(event.message)
    else if (event?.type === 'close') onClose?.({ code: event.code, reason: event.reason })
  }
  const connectionId = await invoke('desktop_runtime_connect', {
    request: { url, ticket },
    events,
  })
  return () => invoke('desktop_runtime_disconnect', { connectionId }).catch(() => false)
}

export function openApplicationRoute(path) {
  if (isDesktopApp()) {
    globalThis.location.assign(path)
    return
  }
  globalThis.open(path, '_blank', 'noopener,noreferrer')
}

function streamUrl(value, ticket) {
  const url = new URL(value)
  url.searchParams.set('ticket', ticket)
  return url.href
}

function loadDesktopAssetSource(path) {
  const cached = desktopAssetCache.get(path)
  if (cached) return cached
  const pending = invoke('desktop_asset_data_url', { path }).catch(error => {
    desktopAssetCache.delete(path)
    if (error instanceof Error) throw error
    throw new Error(String(error || 'Desktop design asset request failed.'))
  })
  desktopAssetCache.set(path, pending)
  return pending
}
