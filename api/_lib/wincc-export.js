import { readFileSync } from 'node:fs'
import { createZip } from '../../hosted-runtime/zip.js'
import { MARKUP_TYPE } from '../../shared/markup-stroke.js'
import { migrateProjectSchema, validateProjectSchema } from '../../shared/project-schema.js'
import { SCADA_PROJECT_TYPE, WINCC_TEMPLATE_COMPONENT_TYPES, projectTypeOf } from '../../shared/project-type.js'

const DEFAULT_COLORS = { background: '#101418', text: '#dce8ef', on: '#22c55e', off: '#64748b', button: '#f6b73c' }

export function exportWinccPackage({ schema: input, revision, schematic }) {
  const schema = migrateProjectSchema(input)
  const issues = validateProjectSchema(schema, { templateOnly: true }).filter(issue => issue.severity === 'error')
  if (issues.length) throw Object.assign(new Error('Fix the draft validation errors before exporting to WinCC.'), { issues })
  if (projectTypeOf(schema) !== SCADA_PROJECT_TYPE) throw new Error('WinCC Unified export requires a SCADA draft.')

  const { project, components } = schema
  const canvas = {
    width: Math.round(project.canvas.width),
    height: Math.round(project.canvas.height),
    background: hexColor(project.canvas.background, DEFAULT_COLORS.background),
  }
  const items = []
  const warnings = []
  const graphics = new Map()
  let catalog
  const scripts = [
    '// Optional WinCC Unified JavaScript event handlers for the template.',
    'export function traceTemplate(message) {',
    '  HMIRuntime.Trace(String(message));',
    '}',
  ]
  const ordered = [...components].sort((left, right) => (left.zIndex || 0) - (right.zIndex || 0))
  for (const component of ordered) {
    if (component.visible === false) continue
    const label = String(component.name || component.type)
    const properties = component.properties || {}
    const isSymbol = component.type === MARKUP_TYPE && properties.tool === 'symbol'
    if (!isSymbol && !WINCC_TEMPLATE_COMPONENT_TYPES.includes(component.type)) {
      warnings.push(label + ' was skipped because this component has no WinCC mapping yet.')
      continue
    }
    const position = integerRect(component.position, canvas)
    if (!position) {
      warnings.push(label + ' was skipped because it is outside the WinCC screen.')
      continue
    }
    if (component.position.rotation && !isSymbol) warnings.push(label + ' uses the unrotated position in WinCC.')

    const name = 'SB_Item_' + String(items.length + 1).padStart(3, '0')
    const item = { name, kind: component.type, label, ...position }
    if (isSymbol) {
      catalog ??= JSON.parse(readFileSync(new URL('../../builder-egui/assets/grindstone/catalog.json', import.meta.url), 'utf8')).symbols
      const symbol = catalog.find(entry => entry.generator === properties.symbolId)
      if (!symbol) {
        warnings.push(label + ' was skipped because its Grindstone graphic is unavailable.')
        continue
      }
      const graphicName = 'SB_Grindstone_' + symbol.generator.replaceAll(/[^a-zA-Z0-9]/g, '_')
      const file = 'assets/grindstone/' + graphicName + '.svg'
      graphics.set(file, symbol.asset.content)
      items.push({
        ...item,
        kind: 'industrial-graphic',
        graphicName,
        file,
        opacity: properties.opacity ?? 1,
        rotation: Math.round((component.position.rotation || 0) % 360),
        stretch: !!symbol.stretch,
      })
      continue
    }

    if (component.type === 'text-label') {
      items.push({ ...item, text: String(properties.text ?? label), color: hexColor(properties.textColor, DEFAULT_COLORS.text) })
    } else if (component.type === 'indicator-lamp') {
      items.push({ ...item, color: properties.templateActive === true
        ? hexColor(properties.onColor, DEFAULT_COLORS.on)
        : hexColor(properties.offColor, DEFAULT_COLORS.off) })
    } else if (component.type === 'control-button') {
      const text = String(properties.label || label)
      items.push({ ...item, text, color: hexColor(properties.buttonColor, DEFAULT_COLORS.button) })
      scripts.push('', 'export function ' + name + '_OnTapped(item, x, y, modifiers, trigger) {',
        '  HMIRuntime.Trace(' + JSON.stringify('Button tapped: ' + text) + ');', '}')
    } else {
      items.push({
        ...item,
        value: properties.templateValue ?? 0,
        color: hexColor(properties.textColor, DEFAULT_COLORS.text),
        background: hexColor(properties.backgroundColor, DEFAULT_COLORS.background),
      })
    }
  }

  if (!items.length) throw new Error('Add a supported widget or a Grindstone symbol before exporting to WinCC.')
  if (schematic) warnings.push('The source schematic is included under assets. Add it to the WinCC screen as a graphic if needed.')
  if (graphics.size) warnings.push('Import the supplied Grindstone SVG files into Project graphics and assign them to the generated Graphic views when the template does not already contain those graphic names.')

  const manifest = {
    format: 'scamatic-wincc-unified/v2',
    tiaVersion: 21,
    source: { name: project.name, slug: project.slug, revision },
    screen: { name: 'SCAMATIC_Overview', ...canvas, items },
    warnings,
  }
  const files = new Map([
    ['manifest.json', JSON.stringify(manifest, null, 2) + '\n'],
    ['README.md', readFileSync(new URL('./wincc/README.md', import.meta.url))],
    ['Generate-WinCCProject.ps1', readFileSync(new URL('./wincc/Generate-WinCCProject.ps1', import.meta.url))],
    ['scripts/wincc-template.js', scripts.join('\n') + '\n'],
    ...graphics,
  ])
  if (graphics.size) files.set('assets/grindstone/LICENSE.txt', readFileSync(new URL('../../public/grindstone-license.txt', import.meta.url)))
  if (schematic) files.set('assets/schematic.svg', schematic)

  const slug = String(project.slug || 'scada').replace(/[^a-z0-9-]/gi, '-').slice(0, 80)
  return {
    fileName: slug + '-wincc-v21.zip',
    contentBase64: createZip(files).toString('base64'),
    sourceRevision: revision,
    componentCount: items.length,
    graphicCount: graphics.size,
    warnings,
  }
}

function integerRect(position, canvas) {
  const x = Math.round(position?.x)
  const y = Math.round(position?.y)
  const width = Math.round(position?.width)
  const height = Math.round(position?.height)
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 1 || height < 1 ||
      x + width > canvas.width || y + height > canvas.height) return null
  return { x, y, width, height }
}

function hexColor(value, fallback) {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : fallback
}
