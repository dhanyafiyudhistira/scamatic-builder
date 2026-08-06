import { createHash } from 'node:crypto'
import { sanitizeSvg } from './svg.js'

export const MAX_DESIGN_ASSET_BYTES = 3 * 1024 * 1024
export const DESIGN_IMAGE_TYPE = 'design-image'

const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml'])
const EXTENSION_MIME_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
})

export function prepareDesignAsset({ fileName, mimeType, content }) {
  const name = safeFileName(fileName)
  const resolvedMimeType = resolveMimeType(name, mimeType)
  if (!SUPPORTED_MIME_TYPES.has(resolvedMimeType)) throw new Error('Choose a PNG, JPG, JPEG, or SVG image.')

  let storedContent
  let byteLength
  let width = null
  let height = null
  let viewBox = null

  if (resolvedMimeType === 'image/svg+xml') {
    const clean = sanitizeSvg(content)
    if (clean.byteLength > MAX_DESIGN_ASSET_BYTES) throw new Error('Image exceeds the 3 MB limit.')
    storedContent = clean.svg
    byteLength = clean.byteLength
    viewBox = clean.viewBox
    ;({ width, height } = svgDimensions(clean))
  } else {
    const buffer = decodeBase64(content)
    if (buffer.byteLength === 0) throw new Error('Image file is empty.')
    if (buffer.byteLength > MAX_DESIGN_ASSET_BYTES) throw new Error('Image exceeds the 3 MB limit.')
    assertRasterSignature(buffer, resolvedMimeType)
    ;({ width, height } = rasterDimensions(buffer, resolvedMimeType))
    storedContent = buffer.toString('base64')
    byteLength = buffer.byteLength
  }

  return {
    kind: DESIGN_IMAGE_TYPE,
    content: storedContent,
    checksum: createHash('sha256').update(storedContent).digest('hex'),
    byteLength,
    metadata: { fileName: name, mimeType: resolvedMimeType, width, height, viewBox },
  }
}

export function referencedDesignAssetIds(schema) {
  return [...new Set((schema?.components || [])
    .filter(component => component?.type === DESIGN_IMAGE_TYPE)
    .map(component => component?.properties?.assetId)
    .filter(value => typeof value === 'string' && value))]
}

export function publicDesignAssets(assets = []) {
  return Object.fromEntries(assets.map(asset => [String(asset._id), {
    id: String(asset._id),
    name: asset.metadata?.fileName || 'Custom element',
    mimeType: asset.metadata?.mimeType || 'application/octet-stream',
    width: asset.metadata?.width || null,
    height: asset.metadata?.height || null,
    src: `/api/elements?projectId=${encodeURIComponent(String(asset.projectId))}&assetId=${encodeURIComponent(String(asset._id))}`,
  }]))
}

function safeFileName(value) {
  const name = String(value || '').split(/[\\/]/).at(-1)?.trim().slice(0, 120)
  if (!name) throw new Error('Image file name is required.')
  return name.replace(/[\u0000-\u001f<>:"|?*]/g, '_')
}

function resolveMimeType(fileName, supplied) {
  const extension = Object.keys(EXTENSION_MIME_TYPES).find(item => fileName.toLowerCase().endsWith(item))
  const fromName = extension ? EXTENSION_MIME_TYPES[extension] : null
  const suppliedType = String(supplied || '').toLowerCase().split(';')[0].trim()
  const normalized = suppliedType === 'image/jpg' ? 'image/jpeg' : suppliedType
  if (fromName && normalized && normalized !== fromName) throw new Error('Image extension does not match its media type.')
  return normalized || fromName || ''
}

function decodeBase64(value) {
  const normalized = String(value || '').replace(/\s/g, '')
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error('Image payload must be valid base64.')
  return Buffer.from(normalized, 'base64')
}

function assertRasterSignature(buffer, mimeType) {
  const png = buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if ((mimeType === 'image/png' && !png) || (mimeType === 'image/jpeg' && !jpeg)) throw new Error('Image content does not match its declared format.')
}

function rasterDimensions(buffer, mimeType) {
  if (mimeType === 'image/png') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue }
    const marker = buffer[offset + 1]
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
    }
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue }
    const segmentLength = buffer.readUInt16BE(offset + 2)
    if (segmentLength < 2) break
    offset += 2 + segmentLength
  }
  return { width: null, height: null }
}

function svgDimensions(clean) {
  if (clean.width && clean.height) return { width: clean.width, height: clean.height }
  const values = String(clean.viewBox || '').trim().split(/[\s,]+/).map(Number)
  return values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0
    ? { width: values[2], height: values[3] }
    : { width: null, height: null }
}
