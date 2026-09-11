import { isIotDashboardProject } from './project-type.js'

export const DASHBOARD_BREAKPOINTS = Object.freeze(['desktop', 'tablet', 'mobile'])

const BREAKPOINT_DEFAULTS = Object.freeze({
  desktop: Object.freeze({ id: 'desktop', label: 'Desktop', minWidth: 1024, width: 1440, height: 900, columns: 12, gridSize: 20 }),
  tablet: Object.freeze({ id: 'tablet', label: 'Tablet', minWidth: 600, width: 834, height: 1112, columns: 8, gridSize: 16 }),
  mobile: Object.freeze({ id: 'mobile', label: 'Mobile', minWidth: 0, width: 390, height: 844, columns: 4, gridSize: 12 }),
})

export function createResponsiveDashboardLayout() {
  return {
    mode: 'responsive-grid',
    gap: 16,
    breakpoints: Object.fromEntries(DASHBOARD_BREAKPOINTS.map(id => {
      const item = BREAKPOINT_DEFAULTS[id]
      return [id, { width: item.width, height: item.height, columns: item.columns }]
    })),
  }
}

export function responsiveDashboardEnabled(schema) {
  return isIotDashboardProject(schema) && schema?.project?.dashboardLayout?.mode === 'responsive-grid'
}

export function dashboardBreakpointMetadata(value) {
  return BREAKPOINT_DEFAULTS[DASHBOARD_BREAKPOINTS.includes(value) ? value : 'desktop']
}

export function dashboardBreakpointForWidth(width) {
  const value = Number(width)
  if (!Number.isFinite(value) || value >= BREAKPOINT_DEFAULTS.desktop.minWidth) return 'desktop'
  return value >= BREAKPOINT_DEFAULTS.tablet.minWidth ? 'tablet' : 'mobile'
}

export function dashboardCanvas(schema, breakpoint = 'desktop') {
  const id = DASHBOARD_BREAKPOINTS.includes(breakpoint) ? breakpoint : 'desktop'
  if (!responsiveDashboardEnabled(schema) || id === 'desktop') return { ...schema?.project?.canvas }
  const fallback = BREAKPOINT_DEFAULTS[id]
  const configured = schema?.project?.dashboardLayout?.breakpoints?.[id] || {}
  return {
    width: boundedInteger(configured.width, 320, 4000, fallback.width),
    height: boundedInteger(configured.height, 240, 10000, fallback.height),
    background: schema?.project?.canvas?.background || '#081018',
  }
}

export function resolveResponsiveDashboard(schema, breakpoint = 'desktop') {
  const id = DASHBOARD_BREAKPOINTS.includes(breakpoint) ? breakpoint : 'desktop'
  const baseCanvas = schema?.project?.canvas || { width: 1440, height: 900, background: '#081018' }
  if (!responsiveDashboardEnabled(schema) || id === 'desktop') {
    return {
      breakpoint: 'desktop',
      canvas: { ...baseCanvas },
      gridSize: dashboardBreakpointMetadata('desktop').gridSize,
      positions: new Map((schema?.components || []).map(component => [component.id, { ...component.position }])),
    }
  }

  const canvas = dashboardCanvas(schema, id)
  const gap = boundedInteger(schema?.project?.dashboardLayout?.gap, 0, 64, 16)
  const components = Array.isArray(schema?.components) ? schema.components : []
  const childIds = new Set(components.flatMap(component => Array.isArray(component?.children) ? component.children : []))
  const rootComponents = components.filter(component => !childIds.has(component.id)).sort((left, right) =>
    (left.position?.y || 0) - (right.position?.y || 0)
    || (left.position?.x || 0) - (right.position?.x || 0)
    || (left.zIndex || 1) - (right.zIndex || 1))
  const positions = new Map()

  if (id === 'tablet') {
    const scale = canvas.width / Math.max(1, Number(baseCanvas.width) || 1440)
    for (const component of components) {
      positions.set(component.id, responsiveOverride(component, id, canvas) || clampResponsivePosition({
        x: Math.round((component.position?.x || 0) * scale),
        y: Math.round((component.position?.y || 0) * scale),
        width: Math.round((component.position?.width || 120) * scale),
        height: Math.round((component.position?.height || 72) * scale),
        rotation: component.position?.rotation || 0,
      }, canvas))
    }
  } else {
    let cursorY = gap
    const contentWidth = Math.max(24, canvas.width - gap * 2)
    for (const component of rootComponents) {
      const override = responsiveOverride(component, id, canvas)
      const position = override || autoMobilePosition(component, contentWidth, cursorY, gap)
      positions.set(component.id, position)
      cursorY = Math.max(cursorY, position.y + position.height + gap)
    }
    for (const component of components.filter(component => childIds.has(component.id))) {
      positions.set(component.id, responsiveOverride(component, id, canvas) || clampResponsivePosition(component.position, canvas))
    }
  }

  const requiredHeight = Math.max(canvas.height, ...Array.from(positions.values()).map(position => position.y + position.height + gap))
  return {
    breakpoint: id,
    canvas: { ...canvas, height: Math.min(10000, Math.ceil(requiredHeight)) },
    gridSize: dashboardBreakpointMetadata(id).gridSize,
    positions,
  }
}

export function responsivePositionPatch(component, breakpoint, position) {
  if (!component || !['tablet', 'mobile'].includes(breakpoint)) return { position }
  return {
    responsivePositions: {
      ...(component.responsivePositions || {}),
      [breakpoint]: cleanPosition(position),
    },
  }
}

export function validResponsivePosition(position) {
  return isPlainObject(position)
    && ['x', 'y', 'width', 'height', 'rotation'].every(key => Number.isFinite(position[key]))
    && position.x >= 0
    && position.y >= 0
    && position.width >= 24
    && position.height >= 24
    && position.x <= 10000
    && position.y <= 10000
    && position.width <= 10000
    && position.height <= 10000
}

function responsiveOverride(component, breakpoint, canvas) {
  const position = component?.responsivePositions?.[breakpoint]
  return validResponsivePosition(position) ? clampResponsivePosition(position, canvas) : null
}

function autoMobilePosition(component, contentWidth, y, gap) {
  const original = component?.position || {}
  const originalWidth = Math.max(24, Number(original.width) || 120)
  const originalHeight = Math.max(24, Number(original.height) || 72)
  const scaledHeight = originalHeight * Math.min(1.6, contentWidth / originalWidth)
  const minimumHeight = component?.type === 'chart' ? 220 : component?.type === 'design-image' ? 180 : 72
  const height = Math.round(Math.max(minimumHeight, Math.min(340, scaledHeight)))
  return cleanPosition({ x: gap, y, width: contentWidth, height, rotation: original.rotation || 0 })
}

function clampResponsivePosition(position = {}, canvas) {
  const width = Math.max(24, Math.min(Number(position.width) || 24, canvas.width))
  const height = Math.max(24, Math.min(Number(position.height) || 24, 4000))
  return cleanPosition({
    x: Math.max(0, Math.min(Number(position.x) || 0, canvas.width - width)),
    y: Math.max(0, Math.min(Number(position.y) || 0, 10000 - height)),
    width,
    height,
    rotation: Number(position.rotation) || 0,
  })
}

function cleanPosition(position) {
  return Object.fromEntries(['x', 'y', 'width', 'height', 'rotation'].map(key => [key, Math.round(Number(position?.[key]) * 1000) / 1000]))
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
