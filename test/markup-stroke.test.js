import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentInstance } from '../shared/component-registry.js'
import { readFileSync } from 'node:fs'
import { MARKUP_SYMBOL_IDS, MARKUP_TOOLS, MARKUP_TYPE, markupDrawing, markupStrokeBounds } from '../shared/markup-stroke.js'
import { createNodeRedExport } from '../shared/node-red-export.js'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'
import { resolveResponsiveDashboard } from '../shared/responsive-dashboard.js'
import { createDeployment, digestJson, verifyDeployment } from '../hosted-runtime/contract.js'
import { prepareDesignAsset, referencedDesignAssetIds } from '../api/_lib/design-assets.js'

function withMarkup(projectType) {
  const schema = createProjectSchema({ id: 'test-project', name: 'Test project', slug: 'test-project', projectType })
  const { canvas } = schema.project
  const stroke = createComponentInstance(MARKUP_TYPE, { id: 'pen', canvas })
  const { position, points } = markupStrokeBounds([{ x: 0, y: 1 }, { x: 54, y: 1 }], canvas)
  stroke.position = position
  stroke.properties.points = points
  return { schema, stroke }
}

test('a markup stroke along the canvas edge saves as a visible unbound layer', () => {
  const { schema, stroke } = withMarkup('scada')
  schema.components.push(stroke)
  assert.deepEqual(stroke.position, { x: 0, y: 0, width: 66, height: 24, rotation: 0 })
  assert.equal(validateProjectSchema(schema).some(issue => issue.path.startsWith('components.0')), false)
  assert.equal(markupStrokeBounds([{ x: 0, y: 1 }, { x: 0, y: 1 }], schema.project.canvas), null)
  stroke.properties.points = [[0, 0], [2, 1]]
  assert.ok(validateProjectSchema(schema).some(issue => issue.code === 'markup.points'))
})

test('markup does not displace IoT widgets when the mobile layout stacks them', () => {
  const { schema, stroke } = withMarkup('iot-dashboard')
  const label = createComponentInstance('text-label', { id: 'label', canvas: schema.project.canvas })
  schema.components = [label]
  const before = resolveResponsiveDashboard(schema, 'mobile')
  stroke.responsivePositions = { mobile: { ...stroke.position, y: before.canvas.height - stroke.position.height } }
  schema.components.unshift(stroke)
  const after = resolveResponsiveDashboard(schema, 'mobile')
  assert.deepEqual(after.positions.get(label.id), before.positions.get(label.id))
  assert.deepEqual(after.positions.get(stroke.id), stroke.responsivePositions.mobile)
  assert.equal(after.canvas.height, before.canvas.height)
})

test('Node-RED flow export reports the omission of decorative markup', () => {
  const { schema, stroke } = withMarkup('scada')
  schema.components.push(stroke)
  const result = createNodeRedExport(schema)
  assert.ok(result.warnings.some(warning => warning.includes('Markup layers')))
  assert.equal(result.stats.metadataOnlyComponents, 0)
})

test('Canvas Lab drawing tools persist as compatible markup layers alongside an existing freehand layer', () => {
  const { schema, stroke } = withMarkup('iot-dashboard')
  schema.components.push(stroke)
  const canvas = schema.project.canvas
  const samples = [{ x: 120, y: 110 }, { x: 155, y: 195 }, { x: 280, y: 220 }]
  for (const tool of Object.keys(MARKUP_TOOLS)) {
    const layer = createComponentInstance(MARKUP_TYPE, { id: `tool-${tool}`, canvas })
    const drawing = markupDrawing(tool, samples, canvas)
    layer.properties = { ...layer.properties, ...drawing.properties }
    layer.position = drawing.position
    schema.components.push(layer)
  }
  const roundTrip = JSON.parse(JSON.stringify(schema))
  assert.equal(validateProjectSchema(roundTrip).filter(issue => issue.path.startsWith('components.')).length, 0)
  assert.equal(markupDrawing('rectangle', [samples[0]], canvas), null)
  assert.equal(markupDrawing('text', [samples[0]], canvas).properties.text, 'Annotation')
})

test('industrial markup references precisely the bundled Grindstone catalog without uploaded assets', () => {
  const catalog = JSON.parse(readFileSync(new URL('../builder-egui/assets/grindstone/catalog.json', import.meta.url), 'utf8'))
  assert.deepEqual([...MARKUP_SYMBOL_IDS].sort(), catalog.symbols.map(symbol => symbol.generator).sort())
  assert.equal(catalog.symbols.find(symbol => symbol.generator === 'pipe.straight').stretch, true)
  const { schema, stroke } = withMarkup('scada')
  schema.components.push(stroke)
  stroke.properties = { tool: 'symbol', symbolId: 'pipe.straight', opacity: .8 }
  assert.equal(validateProjectSchema(schema).filter(issue => issue.path.startsWith('components.')).length, 0)
  assert.ok(resolveResponsiveDashboard(schema, 'desktop').positions.has(stroke.id))
  stroke.properties.symbolId = 'https://example.invalid/remote.svg'
  assert.ok(validateProjectSchema(schema).some(issue => issue.code === 'markup.symbolId'))
})

test('hosted deployments keep the drawing styles and industrial references without adding uploaded assets', () => {
  const { schema, stroke } = withMarkup('iot-dashboard')
  const rounded = createComponentInstance(MARKUP_TYPE, { id: 'rounded', canvas: schema.project.canvas })
  Object.assign(rounded.properties, markupDrawing('rounded-rectangle', [{ x: 30, y: 40 }, { x: 200, y: 240 }], schema.project.canvas).properties)
  stroke.properties = { tool: 'symbol', symbolId: 'pipe.straight', opacity: .8 }
  schema.components = [stroke, rounded]
  const project = schema.project
  const deployment = createDeployment({ project, version: { id: 'published-1', projectId: project.id, version: 1, schema, checksum: digestJson(schema) } })
  verifyDeployment(deployment)
  assert.deepEqual(deployment.payload.version.schema.components.map(component => component.properties), schema.components.map(component => component.properties))
  assert.deepEqual(deployment.payload.assets, [])
})

test('an imported markup image keeps its asset in hosted exports without reflowing mobile widgets', () => {
  const { schema } = withMarkup('iot-dashboard')
  const { canvas } = schema.project
  const label = createComponentInstance('text-label', { id: 'label', canvas })
  const image = createComponentInstance('design-image', { id: 'stamp', canvas })
  const prepared = prepareDesignAsset({ fileName: 'stamp.svg', mimeType: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60"><rect width="80" height="60" fill="#aaccff"/></svg>' })
  Object.assign(image.properties, { assetId: 'stamp-asset', markup: true })
  schema.components = [label]
  const before = resolveResponsiveDashboard(schema, 'mobile')
  schema.components.unshift(image)
  assert.deepEqual(resolveResponsiveDashboard(schema, 'mobile').positions.get(label.id), before.positions.get(label.id))
  assert.deepEqual(referencedDesignAssetIds(schema), ['stamp-asset'])
  const project = schema.project
  const deployment = createDeployment({ project, version: { id: 'published-1', projectId: project.id, version: 1, schema, checksum: digestJson(schema) }, assets: [{ _id: 'stamp-asset', projectId: project.id, ...prepared }] })
  verifyDeployment(deployment)
  assert.equal(deployment.payload.version.schema.components[0].properties.markup, true)
  assert.equal(deployment.payload.assets[0].checksum, prepared.checksum)
  image.properties.markup = 'true'
  assert.ok(validateProjectSchema(schema).some(issue => issue.code === 'designImage.markup'))
})
