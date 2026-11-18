import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'
import { dashboardBreakpointForWidth, resolveResponsiveDashboard, responsivePositionPatch } from '../shared/responsive-dashboard.js'

function dashboard() {
  const schema = createProjectSchema({ id: 'project-1', name: 'Plant dashboard', slug: 'plant-dashboard', projectType: 'iot-dashboard' })
  schema.components = [
    { id: 'a', name: 'A', type: 'text-label', position: { x: 20, y: 20, width: 300, height: 100, rotation: 0 }, zIndex: 1, visible: true, locked: false, binding: {}, properties: {} },
    { id: 'b', name: 'B', type: 'text-label', position: { x: 360, y: 20, width: 300, height: 100, rotation: 0 }, zIndex: 2, visible: true, locked: false, binding: {}, properties: {} },
  ]
  return schema
}

test('IoT dashboard layout resolves automatic tablet and mobile positions', () => {
  const schema = dashboard()
  const tablet = resolveResponsiveDashboard(schema, 'tablet')
  const mobile = resolveResponsiveDashboard(schema, 'mobile')
  assert.equal(tablet.canvas.width, 834)
  assert.ok(tablet.positions.get('b').x < schema.components[1].position.x)
  assert.equal(mobile.positions.get('a').width, 358)
  assert.ok(mobile.positions.get('b').y > mobile.positions.get('a').y)
  assert.equal(dashboardBreakpointForWidth(599), 'mobile')
  assert.equal(dashboardBreakpointForWidth(600), 'tablet')
  assert.equal(dashboardBreakpointForWidth(1024), 'desktop')
})

test('responsive overrides survive schema validation and replace generated positions', () => {
  const schema = dashboard()
  Object.assign(schema.components[0], responsivePositionPatch(schema.components[0], 'mobile', { x: 12, y: 40, width: 180, height: 90, rotation: 0 }))
  assert.deepEqual(resolveResponsiveDashboard(schema, 'mobile').positions.get('a'), { x: 12, y: 40, width: 180, height: 90, rotation: 0 })
  assert.equal(validateProjectSchema(schema).filter(issue => issue.severity === 'error').length, 0)
})
