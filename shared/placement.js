const EPSILON = 0.0001

export function selectionBounds(components = []) {
  if (!components.length) return null
  const left = Math.min(...components.map(component => component.position.x))
  const top = Math.min(...components.map(component => component.position.y))
  const right = Math.max(...components.map(component => component.position.x + component.position.width))
  const bottom = Math.max(...components.map(component => component.position.y + component.position.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function moveSelection(components, selectedIds, requestedDx, requestedDy, canvas) {
  const ids = new Set(selectedIds)
  const movable = components.filter(component => ids.has(component.id) && !component.locked)
  const bounds = selectionBounds(movable)
  if (!bounds) return components

  const dx = clamp(requestedDx, -bounds.x, canvas.width - bounds.x - bounds.width)
  const dy = clamp(requestedDy, -bounds.y, canvas.height - bounds.y - bounds.height)
  return components.map(component => ids.has(component.id) && !component.locked
    ? { ...component, position: { ...component.position, x: clean(component.position.x + dx), y: clean(component.position.y + dy) } }
    : component)
}

export function resizeComponentBounds(position, handle, requestedDx, requestedDy, canvas, options = {}) {
  const minSize = Math.max(1, Number(options.minSize) || 24)
  const gridSize = Math.max(1, Number(options.gridSize) || 1)
  const snap = value => options.snapToGrid ? Math.round(value / gridSize) * gridSize : value
  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.includes('n')
  const south = handle.includes('s')
  const original = {
    left: position.x,
    right: position.x + position.width,
    top: position.y,
    bottom: position.y + position.height,
  }
  let left = west ? clamp(snap(original.left + requestedDx), 0, original.right - minSize) : original.left
  let right = east ? clamp(snap(original.right + requestedDx), original.left + minSize, canvas.width) : original.right
  let top = north ? clamp(snap(original.top + requestedDy), 0, original.bottom - minSize) : original.top
  let bottom = south ? clamp(snap(original.bottom + requestedDy), original.top + minSize, canvas.height) : original.bottom

  if (options.lockAspect && (west || east) && (north || south)) {
    const widthScale = (right - left) / position.width
    const heightScale = (bottom - top) / position.height
    const requestedScale = Math.abs(widthScale - 1) >= Math.abs(heightScale - 1) ? widthScale : heightScale
    const maxWidth = west ? original.right : canvas.width - original.left
    const maxHeight = north ? original.bottom : canvas.height - original.top
    const minScale = Math.max(minSize / position.width, minSize / position.height)
    const maxScale = Math.min(maxWidth / position.width, maxHeight / position.height)
    const scale = clamp(requestedScale, minScale, maxScale)
    const width = position.width * scale
    const height = position.height * scale
    left = west ? original.right - width : original.left
    right = east ? original.left + width : original.right
    top = north ? original.bottom - height : original.top
    bottom = south ? original.top + height : original.bottom
  }

  return {
    ...position,
    x: clean(left),
    y: clean(top),
    width: clean(right - left),
    height: clean(bottom - top),
  }
}

export function arrangeSelection(components, selectedIds, action) {
  const ids = new Set(selectedIds)
  const selected = components.filter(component => ids.has(component.id) && !component.locked)
  const bounds = selectionBounds(selected)
  if (!bounds || selected.length < 2) return components
  if ((action === 'distribute-x' || action === 'distribute-y') && selected.length < 3) return components

  const positions = new Map(selected.map(component => [component.id, { ...component.position }]))
  if (action === 'distribute-x' && selected.length >= 3) distribute(selected, positions, 'x')
  else if (action === 'distribute-y' && selected.length >= 3) distribute(selected, positions, 'y')
  else {
    for (const component of selected) {
      const position = positions.get(component.id)
      if (action === 'left') position.x = bounds.x
      if (action === 'center-x') position.x = bounds.x + (bounds.width - position.width) / 2
      if (action === 'right') position.x = bounds.x + bounds.width - position.width
      if (action === 'top') position.y = bounds.y
      if (action === 'center-y') position.y = bounds.y + (bounds.height - position.height) / 2
      if (action === 'bottom') position.y = bounds.y + bounds.height - position.height
    }
  }

  return components.map(component => positions.has(component.id)
    ? { ...component, position: cleanPosition(positions.get(component.id)) }
    : component)
}

export function resolveSmartSnap(movingBounds, targetBounds, tolerance) {
  const xMatch = closestAnchor(axisAnchors(movingBounds, 'x'), targetBounds.flatMap(bounds => axisAnchors(bounds, 'x')), tolerance)
  const yMatch = closestAnchor(axisAnchors(movingBounds, 'y'), targetBounds.flatMap(bounds => axisAnchors(bounds, 'y')), tolerance)
  return {
    dx: xMatch?.delta || 0,
    dy: yMatch?.delta || 0,
    xGuide: xMatch?.target ?? null,
    yGuide: yMatch?.target ?? null,
  }
}

export function offsetBounds(bounds, dx, dy) {
  return { ...bounds, x: bounds.x + dx, y: bounds.y + dy }
}

function axisAnchors(bounds, axis) {
  const start = axis === 'x' ? bounds.x : bounds.y
  const size = axis === 'x' ? bounds.width : bounds.height
  return [start, start + size / 2, start + size]
}

function closestAnchor(moving, targets, tolerance) {
  let closest = null
  for (const source of moving) {
    for (const target of targets) {
      const delta = target - source
      if (Math.abs(delta) <= tolerance + EPSILON && (!closest || Math.abs(delta) < Math.abs(closest.delta))) {
        closest = { delta, target }
      }
    }
  }
  return closest
}

function distribute(selected, positions, axis) {
  const size = axis === 'x' ? 'width' : 'height'
  const ordered = [...selected].sort((a, b) => a.position[axis] - b.position[axis])
  const start = ordered[0].position[axis]
  const end = ordered.at(-1).position[axis] + ordered.at(-1).position[size]
  const totalSize = ordered.reduce((sum, component) => sum + component.position[size], 0)
  const gap = (end - start - totalSize) / (ordered.length - 1)
  let cursor = start
  for (const component of ordered) {
    positions.get(component.id)[axis] = cursor
    cursor += component.position[size] + gap
  }
}

function cleanPosition(position) {
  return { ...position, x: clean(position.x), y: clean(position.y) }
}

function clean(value) {
  return Math.abs(value - Math.round(value)) < EPSILON ? Math.round(value) : Number(value.toFixed(3))
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
