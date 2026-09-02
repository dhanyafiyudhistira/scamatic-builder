const DESKTOP_BASE_URL = 'https://desktop.scamatic.invalid'
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/

export function connectedDesignAssetPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null
  let url
  try { url = new URL(value, DESKTOP_BASE_URL) } catch { return null }
  if (url.origin !== DESKTOP_BASE_URL || url.pathname !== '/api/elements' || url.hash) return null
  const pairs = [...url.searchParams.entries()]
  if (pairs.length !== 2) return null
  const projectIds = url.searchParams.getAll('projectId')
  const assetIds = url.searchParams.getAll('assetId')
  if (projectIds.length !== 1 || assetIds.length !== 1) return null
  if (!SAFE_IDENTIFIER.test(projectIds[0]) || !SAFE_IDENTIFIER.test(assetIds[0])) return null
  return `${url.pathname}${url.search}`
}

export async function hydrateConnectedDesignAsset(asset, loadSource) {
  const path = connectedDesignAssetPath(asset?.src)
  if (!path) return asset
  return { ...asset, src: await loadSource(path) }
}

export async function hydrateConnectedDesignAssets(assets, loadSource) {
  const entries = await Promise.all(Object.entries(assets || {}).map(async ([id, asset]) => [
    id,
    await hydrateConnectedDesignAsset(asset, loadSource),
  ]))
  return Object.fromEntries(entries)
}
