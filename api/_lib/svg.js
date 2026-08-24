const MAX_SVG_BYTES = 5 * 1024 * 1024
const MAX_ELEMENTS = 10_000
const MAX_DEPTH = 100
const MAX_ATTRIBUTES = 80
const MAX_TEXT_BYTES = 1024 * 1024

const ELEMENTS = [
  'svg', 'g', 'defs', 'symbol', 'use', 'image',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath', 'title', 'desc',
  'linearGradient', 'radialGradient', 'stop', 'pattern',
  'clipPath', 'mask', 'marker',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite',
  'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap',
  'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB',
  'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence',
]
const ELEMENT_NAMES = new Map(ELEMENTS.map(name => [name.toLowerCase(), name]))
const EDITOR_ATTRIBUTE_PREFIXES = ['inkscape:', 'sodipodi:']
const EDITOR_ELEMENT_PREFIXES = ['inkscape:', 'sodipodi:']

const ATTRIBUTES = new Set([
  'id', 'class', 'lang', 'role', 'tabindex', 'focusable', 'version',
  'xmlns', 'xmlns:xlink', 'xml:space', 'href', 'xlink:href',
  'viewbox', 'preserveaspectratio',
  'x', 'y', 'z', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'd', 'points', 'pathlength', 'transform', 'transform-origin',
  'opacity', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'vector-effect', 'color',
  'color-interpolation', 'color-interpolation-filters', 'color-rendering',
  'shape-rendering', 'text-rendering', 'image-rendering', 'visibility',
  'display', 'overflow', 'pointer-events', 'paint-order', 'clip-path',
  'clip-rule', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end',
  'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity', 'lighting-color',
  'offset', 'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'fr',
  'patternunits', 'patterncontentunits', 'patterntransform', 'refx', 'refy',
  'markerwidth', 'markerheight', 'markerunits', 'orient', 'clippathunits',
  'maskunits', 'maskcontentunits', 'filterunits', 'primitiveunits',
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch',
  'font-variant', 'font-variant-ligatures', 'font-variant-caps',
  'font-variant-numeric', 'font-variant-east-asian', 'line-height',
  'text-align', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift',
  'letter-spacing', 'word-spacing', 'text-decoration', 'writing-mode',
  'direction', 'unicode-bidi', 'dx', 'dy', 'rotate', 'textlength',
  'lengthadjust', 'startoffset', 'method', 'spacing',
  'in', 'in2', 'result', 'mode', 'type', 'values', 'operator',
  'k1', 'k2', 'k3', 'k4', 'stddeviation', 'edgemode', 'kernelmatrix',
  'order', 'kernelunitlength', 'targetx', 'targety', 'preservealpha',
  'surfacescale', 'diffuseconstant', 'specularconstant', 'specularexponent',
  'limitingconeangle', 'azimuth', 'elevation', 'pointsatx', 'pointsaty',
  'pointsatz', 'basefrequency', 'numoctaves', 'seed', 'stitchtiles', 'scale',
  'xchannelselector', 'ychannelselector', 'style',
])

const STYLE_PROPERTIES = new Set([
  'alignment-baseline', 'baseline-shift', 'clip-path', 'clip-rule', 'color',
  'color-interpolation', 'color-interpolation-filters', 'color-rendering',
  'direction', 'display', 'dominant-baseline', 'fill', 'fill-opacity',
  'fill-rule', 'filter', 'flood-color', 'flood-opacity', 'font-family',
  'font-size', 'font-style', 'font-stretch', 'font-variant',
  'font-variant-ligatures', 'font-variant-caps', 'font-variant-numeric',
  'font-variant-east-asian', 'font-weight', 'image-rendering', 'line-height',
  'letter-spacing', 'lighting-color', 'marker-end', 'marker-mid', 'marker-start',
  'mask', 'opacity', 'overflow', 'paint-order', 'pointer-events',
  'shape-rendering', 'stop-color', 'stop-opacity', 'stroke', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-opacity', 'stroke-width', 'text-align', 'text-anchor', 'text-decoration',
  'text-rendering', 'transform', 'transform-origin', 'unicode-bidi',
  'vector-effect', 'visibility', 'word-spacing', 'writing-mode',
])

const CANONICAL_ATTRIBUTES = new Map(Object.entries({
  viewbox: 'viewBox',
  preserveaspectratio: 'preserveAspectRatio',
  gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
  patternunits: 'patternUnits',
  patterncontentunits: 'patternContentUnits',
  patterntransform: 'patternTransform',
  clippathunits: 'clipPathUnits',
  maskunits: 'maskUnits',
  maskcontentunits: 'maskContentUnits',
  filterunits: 'filterUnits',
  primitiveunits: 'primitiveUnits',
  markerwidth: 'markerWidth',
  markerheight: 'markerHeight',
  markerunits: 'markerUnits',
  refx: 'refX',
  refy: 'refY',
  textlength: 'textLength',
  lengthadjust: 'lengthAdjust',
  startoffset: 'startOffset',
  stddeviation: 'stdDeviation',
  kernelmatrix: 'kernelMatrix',
  kernelunitlength: 'kernelUnitLength',
  targetx: 'targetX',
  targety: 'targetY',
  preservealpha: 'preserveAlpha',
  surfacescale: 'surfaceScale',
  diffuseconstant: 'diffuseConstant',
  specularconstant: 'specularConstant',
  specularexponent: 'specularExponent',
  limitingconeangle: 'limitingConeAngle',
  pointsatx: 'pointsAtX',
  pointsaty: 'pointsAtY',
  pointsatz: 'pointsAtZ',
  basefrequency: 'baseFrequency',
  numoctaves: 'numOctaves',
  stitchtiles: 'stitchTiles',
  xchannelselector: 'xChannelSelector',
  ychannelselector: 'yChannelSelector',
}))

export function sanitizeSvg(input) {
  if (typeof input !== 'string') throw new Error('SVG payload must be text.')
  const byteLength = Buffer.byteLength(input, 'utf8')
  if (byteLength === 0) throw new Error('SVG file is empty.')
  if (byteLength > MAX_SVG_BYTES) throw new Error('SVG exceeds the 5 MB limit.')

  const source = input.replace(/^\uFEFF/, '').trim().replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('SVG contains a blocked document declaration.')
  const svg = parseAndSanitize(source)
  const openingTag = svg.match(/^<svg\b[^>]*>/)?.[0] || ''
  const viewBox = openingTag.match(/\bviewBox\s*=\s*"([^"]+)"/)?.[1] || null
  const width = parseDimension(openingTag, 'width')
  const height = parseDimension(openingTag, 'height')
  if (!viewBox && (!width || !height)) throw new Error('SVG must define a viewBox or width and height.')
  return { svg, byteLength: Buffer.byteLength(svg, 'utf8'), viewBox, width, height }
}

function parseAndSanitize(source) {
  let cursor = 0
  let output = ''
  let elementCount = 0
  let textBytes = 0
  let rootCount = 0
  const stack = []

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor)
    const textEnd = open === -1 ? source.length : open
    const text = source.slice(cursor, textEnd)
    if (text) {
      if (!stack.length && text.trim()) throw new Error('SVG contains text outside its root element.')
      if (stack.length && !stack[stack.length - 1].ignored) {
        const decoded = decodeXmlEntities(text)
        textBytes += Buffer.byteLength(decoded, 'utf8')
        if (textBytes > MAX_TEXT_BYTES) throw new Error('SVG contains too much text content.')
        output += escapeText(decoded)
      }
    }
    if (open === -1) break

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4)
      if (end === -1) throw new Error('SVG comment is not terminated.')
      cursor = end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', open) || source.startsWith('<!', open) || source.startsWith('<?', open)) {
      throw new Error('SVG contains a blocked declaration.')
    }

    const { token, next } = readTag(source, open)
    cursor = next
    const parsed = parseTag(token, stack[stack.length - 1]?.ignored === true)
    if (parsed.closing) {
      const expected = stack.pop()
      if (!expected || expected.name !== parsed.name) throw new Error('SVG element nesting is invalid.')
      if (!expected.ignored) output += `</${parsed.name}>`
      continue
    }

    elementCount += 1
    if (elementCount > MAX_ELEMENTS) throw new Error(`SVG exceeds the ${MAX_ELEMENTS} element limit.`)
    if (stack.length >= MAX_DEPTH) throw new Error(`SVG exceeds the ${MAX_DEPTH} level nesting limit.`)
    if (!stack.length) {
      rootCount += 1
      if (parsed.name !== 'svg' || rootCount > 1) throw new Error('SVG must contain exactly one svg root element.')
    }

    if (!parsed.ignored) output += `<${parsed.name}${serializeAttributes(parsed.attributes)}${parsed.selfClosing ? '/>' : '>'}`
    if (!parsed.selfClosing) stack.push({ name: parsed.name, ignored: parsed.ignored })
  }

  if (stack.length || rootCount !== 1) throw new Error('SVG root element is missing or corrupt.')
  return output
}

function readTag(source, start) {
  let quote = null
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '>') return { token: source.slice(start + 1, index), next: index + 1 }
  }
  throw new Error('SVG element is not terminated.')
}

function parseTag(token, insideIgnoredElement = false) {
  let source = token.trim()
  const closing = source.startsWith('/')
  if (closing) source = source.slice(1).trim()
  const selfClosing = !closing && source.endsWith('/')
  if (selfClosing) source = source.slice(0, -1).trim()

  let cursor = 0
  const rawName = readName(source, () => cursor, value => { cursor = value })
  const lowerName = rawName.toLowerCase()
  const ignored = insideIgnoredElement || lowerName === 'metadata' || EDITOR_ELEMENT_PREFIXES.some(prefix => lowerName.startsWith(prefix))
  const name = ignored ? rawName : ELEMENT_NAMES.get(lowerName)
  if (!name) throw new Error(`SVG element <${rawName || '?'}> is not allowed.`)
  if (closing) {
    if (source.slice(cursor).trim()) throw new Error('SVG closing element is malformed.')
    return { closing: true, selfClosing: false, name, attributes: [] }
  }

  const attributes = []
  const seen = new Set()
  while (cursor < source.length) {
    cursor = skipWhitespace(source, cursor)
    if (cursor >= source.length) break
    const rawAttribute = readName(source, () => cursor, value => { cursor = value })
    const lower = rawAttribute.toLowerCase()
    if (!rawAttribute || seen.has(lower)) throw new Error('SVG contains a duplicate or malformed attribute.')
    seen.add(lower)
    cursor = skipWhitespace(source, cursor)
    if (source[cursor] !== '=') throw new Error(`SVG attribute ${rawAttribute} must have a quoted value.`)
    cursor = skipWhitespace(source, cursor + 1)
    const quote = source[cursor]
    if (quote !== '"' && quote !== "'") throw new Error(`SVG attribute ${rawAttribute} must use quotes.`)
    const end = source.indexOf(quote, cursor + 1)
    if (end === -1) throw new Error(`SVG attribute ${rawAttribute} is not terminated.`)
    const rawValue = source.slice(cursor + 1, end)
    if (rawValue.includes('<')) throw new Error('SVG attribute contains invalid markup.')
    cursor = end + 1
    const attribute = ignored ? null : sanitizeAttribute(rawAttribute, decodeXmlEntities(rawValue))
    if (attribute) attributes.push(attribute)
    if (attributes.length > MAX_ATTRIBUTES) throw new Error(`SVG element exceeds the ${MAX_ATTRIBUTES} attribute limit.`)
  }
  return { closing: false, selfClosing, name, attributes, ignored }
}

function readName(source, getCursor, setCursor) {
  const start = getCursor()
  let cursor = start
  if (!/[A-Za-z_]/.test(source[cursor] || '')) return ''
  while (/[A-Za-z0-9_.:-]/.test(source[cursor] || '')) cursor += 1
  setCursor(cursor)
  return source.slice(start, cursor)
}

function sanitizeAttribute(rawName, value) {
  const name = rawName.toLowerCase()
  if (name.startsWith('on')) throw new Error('SVG event handler attributes are not allowed.')
  if (name.startsWith('xmlns:') && name !== 'xmlns:xlink') return null
  if (EDITOR_ATTRIBUTE_PREFIXES.some(prefix => name.startsWith(prefix))) return null
  if (!ATTRIBUTES.has(name) && !name.startsWith('aria-') && !name.startsWith('data-')) {
    throw new Error(`SVG attribute ${rawName} is not allowed.`)
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new Error('SVG attribute contains control characters.')

  if (name === 'xmlns' || name === 'xmlns:xlink') {
    const expected = name === 'xmlns' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xlink'
    if (value !== expected) throw new Error('SVG namespace is invalid.')
    return { name, value }
  }
  if (name === 'href' || name === 'xlink:href') {
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value)) throw new Error('SVG references must target an internal element.')
  }
  if (name === 'style') value = sanitizeStyle(value)
  else assertSafeValue(value)

  return { name: CANONICAL_ATTRIBUTES.get(name) || name, value }
}

function sanitizeStyle(value) {
  if (/[{}@]|\/\*/.test(value)) throw new Error('SVG style contains blocked syntax.')
  const declarations = value.split(';').map(item => item.trim()).filter(Boolean)
  if (declarations.length > 80) throw new Error('SVG style contains too many declarations.')
  const sanitized = []
  for (const declaration of declarations) {
    const separator = declaration.indexOf(':')
    if (separator < 1) throw new Error('SVG style declaration is malformed.')
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const propertyValue = declaration.slice(separator + 1).trim()
    if (property.startsWith('-inkscape-')) continue
    if (!STYLE_PROPERTIES.has(property) || !propertyValue) throw new Error(`SVG style property ${property || '?'} is not allowed.`)
    assertSafeValue(propertyValue)
    sanitized.push(`${property}:${propertyValue}`)
  }
  return sanitized.join(';')
}

function assertSafeValue(value) {
  const compact = value.replace(/\s+/g, '')
  if (/javascript:|vbscript:|data:|https?:|file:|\\\\|\/\/|@import|expression\(|-moz-binding|behavior:/i.test(compact)) {
    throw new Error('SVG contains blocked active or external content.')
  }
  const withoutInternalUrls = value.replace(/url\(\s*(['"]?)#[A-Za-z_][A-Za-z0-9_.:-]*\1\s*\)/gi, '')
  if (/url\s*\(/i.test(withoutInternalUrls)) throw new Error('SVG URL references must target an internal element.')
}

function decodeXmlEntities(value) {
  const entityPattern = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi
  if (value.replace(entityPattern, '').includes('&')) throw new Error('SVG contains an unknown or unterminated entity.')
  return value.replace(entityPattern, (match, entity) => {
    const lower = entity.toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return "'"
    const codePoint = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10)
    if (!isXmlCodePoint(codePoint)) throw new Error('SVG contains an invalid character reference.')
    return String.fromCodePoint(codePoint)
  })
}

function isXmlCodePoint(value) {
  return value === 0x9 || value === 0xA || value === 0xD
    || (value >= 0x20 && value <= 0xD7FF)
    || (value >= 0xE000 && value <= 0xFFFD)
    || (value >= 0x10000 && value <= 0x10FFFF)
}

function serializeAttributes(attributes) {
  return attributes.map(attribute => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`).join('')
}
function escapeAttribute(value) { return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function escapeText(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function skipWhitespace(source, cursor) { while (/\s/.test(source[cursor] || '')) cursor += 1; return cursor }

function parseDimension(tag, name) {
  const raw = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`, 'i'))?.[1]
  if (!raw) return null
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}
