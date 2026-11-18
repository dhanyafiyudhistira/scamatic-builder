export const MARKUP_TYPE = 'markup-stroke'
export const isMarkupLayer = component => component?.type === MARKUP_TYPE || (component?.type === 'design-image' && component.properties?.markup === true)
export const MARKUP_MAX_POINTS = 1024
export const MARKUP_DEFAULT_COLOR = '#d5ab68'
export const MARKUP_DEFAULT_WIDTH = 4
export const MARKUP_TOOLS = Object.freeze({
  pencil: 'Pencil', line: 'Line', arrow: 'Arrow', 'double-arrow': 'Double arrow', curve: 'Curve',
  rectangle: 'Rectangle', 'rounded-rectangle': 'Rounded rectangle', ellipse: 'Ellipse', triangle: 'Triangle',
  diamond: 'Diamond', polygon: 'Polygon', star: 'Star', text: 'Annotation text',
})
export const MARKUP_SYMBOL_IDS = Object.freeze([
  'pump.centrifugal', 'valve.two-way', 'motor.induction', 'tank.process', 'conveyor.belt',
  'exchanger.shell-tube', 'blower.centrifugal', 'compressor.air', 'mixer.static',
  'instrument.transmitter', 'pipe.fitting', 'pipe.straight',
])
export const MARKUP_PROPERTY_FIELDS = Object.freeze([
  'tool', 'points', 'color', 'strokeWidth', 'opacity', 'symbolId', 'filled', 'fillColor',
  'cornerRadius', 'bend', 'sides', 'tips', 'innerRatio', 'text', 'fontSize',
])
const lineTools = ['line', 'arrow', 'double-arrow']
const fillTools = ['rectangle', 'rounded-rectangle', 'ellipse', 'triangle', 'diamond', 'polygon', 'star']
export const markupUsesFill = tool => fillTools.includes(tool)

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const round = (value, scale) => Math.round(value * scale) / scale

export function markupStrokeBounds(points, canvas) {
  if (points.length < 2) return null
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const right = Math.max(...xs)
  const bottom = Math.max(...ys)
  if (Math.hypot(right - left, bottom - top) < 1) return null

  const width = Math.min(canvas.width, Math.max(24, round(right - left + 12, 100)))
  const height = Math.min(canvas.height, Math.max(24, round(bottom - top + 12, 100)))
  const x = clamp(round((left + right - width) / 2, 100), 0, canvas.width - width)
  const y = clamp(round((top + bottom - height) / 2, 100), 0, canvas.height - height)
  return {
    position: { x, y, width, height, rotation: 0 },
    points: points.map(point => [round(clamp((point.x - x) / width, 0, 1), 100000), round(clamp((point.y - y) / height, 0, 1), 100000)]),
  }
}

export function validMarkupPoints(points) {
  return Array.isArray(points) && points.length >= 2 && points.length <= MARKUP_MAX_POINTS
    && points.every(point => Array.isArray(point) && point.length === 2 && point.every(value => Number.isFinite(value) && value >= 0 && value <= 1))
    && points.some(point => point[0] !== points[0][0] || point[1] !== points[0][1])
}

export function markupDrawing(tool, samples, canvas) {
  const [start] = samples
  const end = samples.at(-1)
  if (tool === 'pencil' || lineTools.includes(tool)) {
    const bounds = markupStrokeBounds(tool === 'pencil' ? samples : [start, end], canvas)
    if (!bounds) return null
    return { position: bounds.position, properties: { tool, points: bounds.points } }
  }
  const dx = end.x - start.x
  const dy = end.y - start.y
  const click = Math.hypot(dx, dy) < 3
  if (click && tool !== 'text') return null
  const position = markupBox(canvas, Math.min(start.x, end.x), Math.min(start.y, end.y), click ? 240 : Math.abs(dx), click ? 64 : Math.abs(dy))
  const properties = { tool }
  if (markupUsesFill(tool)) Object.assign(properties, { filled: false, fillColor: '#35383e' })
  if (tool === 'rounded-rectangle') properties.cornerRadius = 12
  if (tool === 'curve') properties.bend = dy < 0 ? -1 : 1
  if (tool === 'polygon') properties.sides = 6
  if (tool === 'star') Object.assign(properties, { tips: 5, innerRatio: .45 })
  if (tool === 'text') Object.assign(properties, { text: 'Annotation', fontSize: 24 })
  return { position, properties }
}

export function markupBox(canvas, left, top, requestedWidth, requestedHeight) {
  const width = clamp(round(requestedWidth, 100), 24, canvas.width)
  const height = clamp(round(requestedHeight, 100), 24, canvas.height)
  const x = clamp(round(left, 100), 0, canvas.width - width)
  const y = clamp(round(top, 100), 0, canvas.height - height)
  return { x, y, width, height, rotation: 0 }
}

export function markupPropertyIssues({ tool = 'pencil', points, color, strokeWidth, opacity, symbolId, filled, fillColor, cornerRadius, bend, sides, tips, innerRatio, text, fontSize } = {}) {
  const issue = (field, message, code = field) => ({ code: `markup.${code}`, field, message })
  const issues = []
  const colorValid = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)
  const between = (value, min, max) => Number.isFinite(value) && value >= min && value <= max
  if (opacity !== undefined && !between(opacity, 0, 1)) issues.push(issue('opacity', 'Markup opacity must be between 0 and 1.'))
  if (tool === 'symbol') {
    if (!MARKUP_SYMBOL_IDS.includes(symbolId)) issues.push(issue('symbolId', 'Choose a symbol from the industrial markup catalog.'))
    return issues
  }
  if (typeof tool !== 'string' || !Object.hasOwn(MARKUP_TOOLS, tool)) return [issue('tool', 'Choose a supported markup tool.')]
  if (!colorValid(color)) issues.push(issue('color', 'Markup color must be a six-digit hexadecimal color.'))
  if (!between(strokeWidth, .5, 32)) issues.push(issue('strokeWidth', 'Markup stroke width must be between 0.5 and 32.', 'width'))
  if ((tool === 'pencil' || lineTools.includes(tool)) && (!validMarkupPoints(points) || (tool !== 'pencil' && points.length !== 2))) {
    issues.push(issue('points', `Markup needs a visible path with normalized points (maximum ${MARKUP_MAX_POINTS}).`))
  }
  if (markupUsesFill(tool) && (typeof filled !== 'boolean' || !colorValid(fillColor))) issues.push(issue('fillColor', 'Markup fill requires a six-digit hexadecimal color.'))
  if (tool === 'rounded-rectangle' && !between(cornerRadius, 0, 200)) issues.push(issue('cornerRadius', 'Markup corner radius must be between 0 and 200.'))
  if (tool === 'curve' && !between(bend, -1, 1)) issues.push(issue('bend', 'Markup curve bend must be between -1 and 1.'))
  if (tool === 'polygon' && (!Number.isInteger(sides) || !between(sides, 3, 12))) issues.push(issue('sides', 'Markup polygons must have between 3 and 12 sides.'))
  if (tool === 'star' && (!Number.isInteger(tips) || !between(tips, 3, 12) || !between(innerRatio, .15, .85))) issues.push(issue('tips', 'Markup stars require 3 to 12 tips and an inset between 0.15 and 0.85.'))
  if (tool === 'text' && (typeof text !== 'string' || text.length > 8192 || !between(fontSize, 8, 160))) issues.push(issue('text', 'Markup text must be at most 8,192 characters with a font size between 8 and 160.'))
  return issues
}
