import { lazy, Suspense, useRef, useState } from 'react'
import { MARKUP_DEFAULT_COLOR, MARKUP_DEFAULT_WIDTH, MARKUP_MAX_POINTS, markupBox, markupDrawing } from '../../shared/markup-stroke.js'

const GrindstoneSymbol = lazy(() => import('./MarkupSymbols.jsx').then(module => ({ default: module.GrindstoneSymbol })))

// Iconoir Edit Pencil, MIT, copyright (c) 2021 Luca Burgio.
// https://github.com/iconoir-icons/iconoir/blob/d73b7282ddd57caec341a6990c8456b911186e9b/icons/regular/edit-pencil.svg
export function MarkupIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" strokeWidth="1.5" fill="none" aria-hidden="true"><path d="M14.3632 5.65156L15.8431 4.17157C16.6242 3.39052 17.8905 3.39052 18.6716 4.17157L20.0858 5.58579C20.8668 6.36683 20.8668 7.63316 20.0858 8.41421L18.6058 9.8942M14.3632 5.65156L4.74749 15.2672C4.41542 15.5993 4.21079 16.0376 4.16947 16.5054L3.92738 19.2459C3.87261 19.8659 4.39148 20.3848 5.0115 20.33L7.75191 20.0879C8.21972 20.0466 8.65806 19.8419 8.99013 19.5099L18.6058 9.8942M14.3632 5.65156L18.6058 9.8942" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

const coordinates = points => points.map(([x, y]) => `${x},${y}`).join(' ')

function arrowHead([x0, y0], [x, y]) {
  const distance = Math.hypot(x - x0, y - y0)
  if (!distance) return []
  const length = Math.min(20, distance * .4)
  const dx = (x - x0) * length / distance
  const dy = (y - y0) * length / distance
  return [[x - dx - dy * .5, y - dy + dx * .5], [x, y], [x - dx + dy * .5, y - dy - dx * .5]]
}

function polygonPoints(tool, { sides = 6, tips = 5, innerRatio = .45 }, width, height) {
  const count = { triangle: 3, diamond: 4, polygon: sides, star: tips * 2 }[tool]
  const points = Array.from({ length: count }, (_, index) => {
    const angle = index / count * 2 * Math.PI - Math.PI / 2
    const radius = tool === 'star' && index % 2 ? innerRatio : 1
    return [Math.cos(angle) * radius, Math.sin(angle) * radius]
  })
  const xs = points.map(point => point[0])
  const ys = points.map(point => point[1])
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return points.map(([x, y]) => [(x - left) / (Math.max(...xs) - left) * width, (y - top) / (Math.max(...ys) - top) * height])
}

export function MarkupGeometry({ properties = {}, width, height, icon = false }) {
  const { tool = 'pencil', color = MARKUP_DEFAULT_COLOR, strokeWidth = MARKUP_DEFAULT_WIDTH, opacity = 1 } = properties
  const stroke = { className: 'sb-markup-line', fill: properties.filled ? properties.fillColor : 'none', stroke: color, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }
  if (tool === 'symbol') return <Suspense fallback={null}><GrindstoneSymbol symbolId={properties.symbolId} opacity={opacity} /></Suspense>
  if (tool === 'text' && !icon) return <div className="sb-markup-text" style={{ color, opacity, fontSize: `${(properties.fontSize ?? 24) * 100 / height}cqh` }}>{properties.text}</div>

  let shape
  switch (tool) {
    case 'line': case 'arrow': case 'double-arrow': case 'pencil': {
      const points = (properties.points || []).map(([x, y]) => [x * width, y * height])
      const directional = ['arrow', 'double-arrow'].includes(tool) && points.length >= 2
      shape = <><polyline {...stroke} points={coordinates(points)} />
        {directional && <polyline {...stroke} points={coordinates(arrowHead(points[0], points[1]))} />}
        {directional && tool === 'double-arrow' && <polyline {...stroke} points={coordinates(arrowHead(points[1], points[0]))} />}
      </>
      break
    }
    case 'curve': {
      const bend = properties.bend ?? 1
      const y = bend < 0 ? 0 : height
      shape = <path {...stroke} d={`M0 ${y} Q${width / 2} ${y - 2 * height * bend} ${width} ${y}`} />
      break
    }
    case 'rectangle': case 'rounded-rectangle':
      shape = <rect {...stroke} width={width} height={height} rx={tool === 'rounded-rectangle' ? properties.cornerRadius : 0} />
      break
    case 'ellipse':
      shape = <ellipse {...stroke} cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2} />
      break
    case 'triangle': case 'diamond': case 'polygon': case 'star':
      shape = <polygon {...stroke} points={coordinates(polygonPoints(tool, properties, width, height))} />
      break
    case 'text':
      shape = <path {...stroke} d={`M1 3H${width - 1} M${width / 2} 3V${height - 2}`} />
      break
  }
  const viewBox = icon ? `-4 -4 ${width + 8} ${height + 8}` : `0 0 ${width} ${height}`
  return <svg className={icon ? undefined : 'sb-markup-stroke'} viewBox={viewBox} preserveAspectRatio="none" opacity={opacity} aria-hidden="true">{shape}</svg>
}

export function symbolPlacement(symbol, point, canvas) {
  const scale = Math.min(1.6, canvas.width * .45 / symbol.width, canvas.height * .45 / symbol.height)
  const width = symbol.width * scale
  const height = symbol.height * scale
  const position = markupBox(canvas, point.x - width / 2, point.y - height / 2, width, height)
  return { position, name: symbol.label, properties: { tool: 'symbol', symbolId: symbol.id, opacity: 1 } }
}

export function MarkupPad({ canvas, pointAt, tool, onCommit }) {
  const drawing = useRef(null)
  const [preview, setPreview] = useState(null)
  const locate = event => pointAt(event, event.currentTarget.getBoundingClientRect(), canvas)
  const geometry = stroke => tool.symbol
    ? symbolPlacement(tool.symbol, stroke.points.at(-1), canvas)
    : markupDrawing(tool.id, stroke.points, canvas)

  const start = event => {
    if (event.button !== 0 || drawing.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const first = locate(event)
    drawing.current = { pointer: event.pointerId, points: [first] }
    setPreview(geometry(drawing.current))
  }
  const sample = (event, stroke) => {
    const point = locate(event)
    if (tool.id !== 'pencil') {
      stroke.points[1] = point
      return
    }
    const last = stroke.points.at(-1)
    if (Math.hypot(point.x - last.x, point.y - last.y) < .75) return
    if (stroke.points.length >= MARKUP_MAX_POINTS) stroke.points = stroke.points.filter((_, index) => index % 2 === 0)
    stroke.points.push(point)
  }
  const move = event => {
    const stroke = drawing.current
    if (!stroke || stroke.pointer !== event.pointerId) return
    sample(event, stroke)
    setPreview(geometry(stroke))
  }
  const finish = event => {
    const stroke = drawing.current
    if (!stroke || stroke.pointer !== event.pointerId) return
    if (event.type === 'pointerup') sample(event, stroke)
    drawing.current = null
    setPreview(null)
    if (event.type !== 'pointerup') return
    const layer = geometry(stroke)
    if (layer) onCommit(layer)
  }

  const position = preview?.position
  return <div className={`sb-markup-pad ${tool.symbol ? 'is-placing-symbol' : ''}`} aria-hidden="true" onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>
    {position && <div className="sb-markup-drag-preview" style={{ left: `${position.x / canvas.width * 100}%`, top: `${position.y / canvas.height * 100}%`, width: `${position.width / canvas.width * 100}%`, height: `${position.height / canvas.height * 100}%` }}>
      <MarkupGeometry properties={preview.properties} width={position.width} height={position.height} />
    </div>}
  </div>
}
