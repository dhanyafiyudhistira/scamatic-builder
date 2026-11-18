// Hosted builds never import the Tauri IPC bridge.
export const isDesktopApp = () => false
export const clearDesktopAssetCache = () => {}
export const resolveDesignAssets = async assets => assets || {}
export const resolveDesignAsset = async asset => asset
export const desktopApiRequest = () => { throw new Error('Desktop transport is unavailable in hosted runtime.') }
export function connectRuntimeStream({ url, ticket, onOpen, onMessage, onError, onClose }) {
  const target = new URL(url)
  target.searchParams.set('ticket', ticket)
  const socket = new WebSocket(target)
  socket.addEventListener('open', onOpen)
  socket.addEventListener('message', event => onMessage?.(event.data))
  socket.addEventListener('error', () => onError?.('Runtime stream failed.'))
  socket.addEventListener('close', onClose)
  return () => socket.close()
}
