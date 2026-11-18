import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPONENT_REGISTRY, createComponentInstance } from '../shared/component-registry.js'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'
import { GAUGE_START_ANGLE, GAUGE_SWEEP_ANGLE, gaugeTicks } from '../shared/gauge.js'
import { CHART_SERIES_COLORS } from '../shared/chart-data.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'builder-egui/assets')
mkdirSync(output, { recursive: true })
// Native previews use the production registry and effective IoT matte skin.
// Do not inject preview-only properties into documents or imported components.
const iotStyles = Object.fromEntries(Object.entries(COMPONENT_REGISTRY)
  .filter(([, d]) => d.library !== false && (!d.projectTypes || d.projectTypes.includes('iot-dashboard')))
  .map(([kind, d]) => [kind, Object.fromEntries(Object.entries(d.defaultProperties)
    .filter(([, value]) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)))]))
iotStyles.chart.seriesColors = CHART_SERIES_COLORS
writeFileSync(resolve(output, 'iot-style-defaults.json'), JSON.stringify(iotStyles, null, 2) + '\n')
const css = readFileSync(resolve(root, 'src/builder.css'), 'utf8')
const matte = Object.fromEntries(['matte', 'matte-raised', 'matte-line', 'matte-muted'].map(name => {
  const value = css.match(new RegExp(`--sb-iot-${name}:\\s*(#[\\da-f]{6})`, 'i'))?.[1]
  if (!value) throw new Error(`Missing production IoT skin variable: ${name}`)
  return [name, value]
}))
writeFileSync(resolve(output, 'iot-runtime-reference.json'), JSON.stringify({
  sources: ['src/platform/RuntimeCanvas.jsx', 'src/builder.css', 'shared/component-registry.js', 'shared/gauge.js'],
  matte, gauge: { startAngle: GAUGE_START_ANGLE, sweepAngle: GAUGE_SWEEP_ANGLE },
  gaugeFixtures: [
    { min: 0, max: 100, tickCount: 10 },
    { min: -10, max: 10, tickCount: 4 },
    { min: 0, max: 1, tickCount: 12 },
  ].map(properties => ({ properties, ticks: gaugeTicks(properties) })),
}, null, 2) + '\n')
writeFileSync(resolve(output, 'component-catalog.json'), JSON.stringify(COMPONENT_REGISTRY, null, 2) + '\n')
const schema = createProjectSchema({ id: 'egui-demo-project', name: 'SCAMATIC Canvas Lab', slug: 'scamatic-canvas-lab', projectType: 'scada', width: 1200, height: 760 })
schema.project.canvas.background = '#151719'
schema.tags = [
  { id: 'pump-running', name: 'Pump running', sourceId: 'source_mock', path: 'PumpRunning', dataType: 'boolean', access: 'read' },
  { id: 'tank-level', name: 'Tank level', sourceId: 'source_mock', path: 'TankLevel', dataType: 'number', access: 'read', engineering: { min: 0, max: 100, unit: '%', decimals: 1 } },
]
function add(type, id, x, y, width, height, properties, tagId = null) {
  const component = createComponentInstance(type, { id, tagId, canvas: schema.project.canvas, index: schema.components.length })
  component.position = { x, y, width, height, rotation: 0 }
  Object.assign(component.properties, properties)
  schema.components.push(component)
}
add('text-label', 'heading', 60, 45, 700, 62, { text: 'WATER TREATMENT / DESIGN STUDY', fontSize: 28, textColor: '#e2e3e6' })
add('pump', 'pump', 170, 230, 200, 145, { label: 'FEED PUMP P-101' }, 'pump-running')
add('valve', 'valve', 560, 250, 170, 120, { label: 'INLET VALVE' }, 'pump-running')
add('indicator-lamp', 'status', 900, 180, 125, 125, { label: 'PUMP STATUS', offColor: '#7b7e85' }, 'pump-running')
add('gauge', 'level', 860, 380, 250, 220, { label: 'TANK LEVEL' }, 'tank-level')
add('value-span', 'value', 170, 480, 240, 90, { label: 'PROCESS LEVEL', suffix: '%' }, 'tank-level')
add('text-label', 'note', 60, 660, 1000, 50, { text: 'Select an object, drag to move, use the corner handle to resize.', fontSize: 17, textColor: '#989ba2' })
schema.project.svgAssetId = 'egui-demo-schematic'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 760"><path d="M360 300H560M730 300H815V475H860" fill="none" stroke="#979ba2" stroke-width="8"/><rect x="805" y="135" width="320" height="500" rx="18" fill="none" stroke="#3c3e42" stroke-width="2"/></svg>'
const errors = validateProjectSchema(schema, { requireAsset: true }).filter(issue => issue.severity === 'error')
if (errors.length) throw new Error(JSON.stringify(errors))
writeFileSync(resolve(output, 'demo-project.json'), JSON.stringify({ format: 'scamatic-egui-draft/v1', schema, svg }, null, 2) + '\n')
const iot = createProjectSchema({ id: 'egui-iot-demo', name: 'IoT Dashboard / Design Study', slug: 'iot-dashboard-design-study', projectType: 'iot-dashboard', width: 1000, height: 740 })
iot.project.canvas.background = '#151719'
iot.tags = [
  { id: 'temperature', name: 'Room temperature', sourceId: 'source_mock', path: 'Temperature', dataType: 'number', access: 'read', engineering: { min: 0, max: 60, unit: '°C', decimals: 1 } },
  { id: 'humidity', name: 'Relative humidity', sourceId: 'source_mock', path: 'Humidity', dataType: 'number', access: 'read', engineering: { min: 0, max: 100, unit: '%', decimals: 1 } },
  { id: 'online', name: 'Device online', sourceId: 'source_mock', path: 'Online', dataType: 'boolean', access: 'read' },
  { id: 'alarm', name: 'Device alarm', sourceId: 'source_mock', path: 'Alarm', dataType: 'boolean', access: 'read' },
  { id: 'power', name: 'Power command', sourceId: 'source_mock', path: 'Power', dataType: 'boolean', access: 'read-write' },
  { id: 'target', name: 'Temperature target', sourceId: 'source_mock', path: 'Target', dataType: 'number', access: 'read-write', engineering: { min: 16, max: 32, unit: '°C', decimals: 1 }, writeConstraints: { min: 16, max: 32, step: 0.5 } },
  { id: 'mode', name: 'Operation mode', sourceId: 'source_mock', path: 'Mode', dataType: 'enum', access: 'read-write', enumValues: ['MANUAL', 'AUTO', 'RESET'] },
]
function addIot(type, id, x, y, width, height, properties, tagId = null) {
  const component = createComponentInstance(type, { id, tagId, canvas: iot.project.canvas, index: iot.components.length })
  component.position = { x, y, width, height, rotation: 0 }
  Object.assign(component.properties, properties)
  iot.components.push(component)
  return component
}
addIot('text-label', 'iot-heading', 32, 24, 936, 46, { text: 'ENVIRONMENT / IOT DASHBOARD', fontSize: 28 })
addIot('text-label', 'iot-note', 32, 76, 936, 30, { text: 'Desktop design study · choose a widget from the palette to begin', fontSize: 14, textColor: '#989ba2' })
addIot('value-span', 'iot-temperature', 32, 128, 280, 140, { label: 'ROOM TEMPERATURE', suffix: '°C' }, 'temperature')
addIot('gauge', 'iot-humidity', 354, 128, 280, 280, { label: 'RELATIVE HUMIDITY', suffix: '%' }, 'humidity')
addIot('indicator-lamp', 'iot-online', 688, 128, 160, 160, { label: 'DEVICE CONNECTION' }, 'online')
const iotChart = addIot('chart', 'iot-chart', 32, 304, 220, 72, { label: 'ENVIRONMENT HISTORY', windowMinutes: 60, showLegend: true }, 'temperature')
iotChart.binding.tagIds = ['temperature', 'humidity']
addIot('alarm', 'iot-alarm', 678, 312, 180, 170, { label: 'DEVICE ALARM', soundEnabled: false }, 'alarm')
addIot('control-button', 'iot-power', 32, 420, 220, 72, { label: 'POWER COMMAND' }, 'power')
addIot('control-popup', 'iot-popup', 692, 552, 260, 72, { label: 'DEVICE CONTROLS', triggerLabel: 'OPEN CONTROLS' })
addIot('tuning-slider', 'iot-target', 32, 552, 360, 132, { label: 'TEMPERATURE TARGET', min: 16, max: 32, step: 0.5, suffix: '°C' }, 'target')
addIot('operation-shifter', 'iot-mode', 424, 552, 236, 72, { label: 'OPERATION MODE' }, 'mode')
const iotErrors = validateProjectSchema(iot).filter(issue => issue.severity === 'error')
if (iotErrors.length) throw new Error(JSON.stringify(iotErrors))
writeFileSync(resolve(output, 'demo-iot-project.json'), JSON.stringify({ format: 'scamatic-egui-draft/v1', schema: iot }, null, 2) + '\n')
console.log('Prepared egui component catalog, SCADA example and IoT dashboard example from the shared project schema.')
