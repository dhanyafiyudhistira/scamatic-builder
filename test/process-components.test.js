import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createComponentInstance } from '../shared/component-registry.js'
import { createNodeRedExport, serializeNodeRedExport } from '../shared/node-red-export.js'
import { parseNodeRedFlow } from '../shared/node-red-import.js'
import { createProjectSchema, hasBlockingIssues, migrateProjectSchema, PROJECT_SCHEMA_VERSION, validateProjectSchema } from '../shared/project-schema.js'

const processTypes = ['valve', 'motor', 'pump', 'fan', 'pipe']

function processSchema() {
  const schema = createProjectSchema({ id: 'process-components', name: 'Process components', slug: 'process-components' })
  schema.tags = [{ id: 'running', name: 'Running', path: 'running', dataType: 'boolean', access: 'read', sourceId: 'source_mock' }]
  schema.components = processTypes.map((type, index) => createComponentInstance(type, {
    id: `component-${type}`,
    canvas: schema.project.canvas,
    tagId: 'running',
    index,
  }))
  return schema
}

test('Valve, Motor, Pump, Fan, and Pipe publish as readable SCADA indicators', () => {
  const schema = processSchema()
  const issues = validateProjectSchema(schema)
  assert.equal(hasBlockingIssues(issues), false)
  assert.deepEqual(schema.components.map(component => component.type), processTypes)
  assert.equal(schema.components.find(component => component.type === 'pipe').properties.activeText, 'FLOW ACTIVE')
})

test('process indicators reject IoT placement, write-only state, and unsafe appearance properties', () => {
  const iot = processSchema()
  iot.project.projectType = 'iot-dashboard'
  iot.project.dashboardLayout = {
    mode: 'responsive-grid',
    gap: 16,
    breakpoints: {
      desktop: { width: 1920, height: 1080, columns: 12 },
      tablet: { width: 834, height: 1194, columns: 8 },
      mobile: { width: 390, height: 844, columns: 4 },
    },
  }
  assert.ok(validateProjectSchema(iot).some(issue => issue.code === 'component.projectType'))

  const invalid = processSchema()
  invalid.tags[0].access = 'write'
  invalid.components = [invalid.components.find(component => component.type === 'pipe')]
  invalid.components[0].properties = {
    ...invalid.components[0].properties,
    activeColor: 'cyan',
    inactiveText: '',
    direction: 'sideways',
    animate: 'yes',
  }
  const codes = validateProjectSchema(invalid).map(issue => issue.code)
  assert.ok(codes.includes('binding.writeonly'))
  assert.ok(codes.includes('process.color'))
  assert.ok(codes.includes('process.stateText'))
  assert.ok(codes.includes('process.animate'))
  assert.ok(codes.includes('pipe.direction'))
})

test('Pipe stream configuration round-trips through safe Node-RED metadata', () => {
  const schema = processSchema()
  const pipe = schema.components.find(component => component.type === 'pipe')
  pipe.properties = {
    ...pipe.properties,
    activeText: 'PRODUCT FLOW',
    inactiveText: 'FLOW STOPPED',
    activeColor: '#11ccdd',
    idleColor: '#334455',
    direction: 'reverse',
    animate: false,
    rule: { operator: 'eq', value: true },
  }
  schema.components = [pipe]

  const exported = createNodeRedExport(schema)
  assert.equal(exported.stats.dashboardNodes, 1)
  assert.equal(exported.stats.metadataOnlyComponents, 0)
  assert.equal(exported.nodes.some(node => node.type === 'ui_text' && node.name === pipe.name), true)

  const analysis = parseNodeRedFlow(serializeNodeRedExport(exported))
  const candidate = analysis.candidates.find(item => item.path === 'running')
  assert.equal(candidate.componentType, 'pipe')
  assert.deepEqual(candidate.componentProperties, {
    label: 'FLOW',
    rule: { operator: 'eq', value: true },
    activeColor: '#11ccdd',
    idleColor: '#334455',
    activeText: 'PRODUCT FLOW',
    inactiveText: 'FLOW STOPPED',
    glow: true,
    animate: false,
    direction: 'reverse',
  })
})

test('1.7 projects migrate without replacing canonical numeric engineering', () => {
  const legacy = createProjectSchema({ id: 'legacy-process', name: 'Legacy process', slug: 'legacy-process' })
  legacy.schemaVersion = '1.7.0'
  legacy.tags = [{ id: 'pressure', name: 'Pressure', path: 'pressure', dataType: 'number', access: 'read', sourceId: 'source_mock', engineering: { min: 10, max: 20, unit: 'bar', decimals: 2 } }]
  const migrated = migrateProjectSchema(legacy)
  assert.equal(migrated.schemaVersion, PROJECT_SCHEMA_VERSION)
  assert.deepEqual(migrated.tags[0].engineering, legacy.tags[0].engineering)
})

test('runtime and inspector include process symbols and an accessible animated Pipe stream', async () => {
  const [runtime, inspector, css] = await Promise.all([
    readFile(new URL('../src/platform/RuntimeCanvas.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/platform/BuilderPanels.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/builder.css', import.meta.url), 'utf8'),
  ])
  for (const type of processTypes) assert.match(runtime, new RegExp(`type === '${type}'|type-${type}`))
  assert.match(runtime, /quality === 'good' && evaluateRule/)
  assert.match(runtime, /role="status"/)
  assert.match(inspector, /Animate stream while active/)
  assert.match(css, /@keyframes sb-pipe-stream/)
  assert.match(css, /\.sb-pipe-component\.is-active\.is-animated \.sb-pipe-stream/)
  assert.match(css, /prefers-reduced-motion[\s\S]*\.sb-pipe-component\.is-animated/)
})
