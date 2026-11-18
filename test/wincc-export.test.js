import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { exportWinccPackage } from '../api/_lib/wincc-export.js'
import { createComponentInstance } from '../shared/component-registry.js'
import { MARKUP_TYPE } from '../shared/markup-stroke.js'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'

test('WinCC exports static, unbound widgets and Grindstone artwork without legacy runtime data', () => {
  const schema = createProjectSchema({ id: 'wincc-test', name: 'WinCC Test', slug: 'wincc-test' })
  const button = widget('control-button', { label: 'Open panel' })
  const gauge = widget('gauge', { templateValue: 42 })
  const lamp = widget('indicator-lamp', { templateActive: true, onColor: '#91abee' })
  const pump = widget(MARKUP_TYPE, { tool: 'symbol', symbolId: 'pump.centrifugal', opacity: 1 })
  schema.tags.push({ id: 'legacy-tag', name: 'Legacy tag', path: 'private.source', dataType: 'boolean', access: 'read', sourceId: 'source_mock' })
  lamp.binding.tagId = 'legacy-tag'
  schema.project.runtimeProfile = 'real'

  const original = structuredClone(schema)
  const issues = validateProjectSchema(schema, { templateOnly: true })
  assert.equal(issues.some(issue => issue.severity === 'error' || issue.code === 'binding.missing'), false)
  assert.ok(validateProjectSchema(schema).some(issue => issue.code === 'profile.liveSource'))

  const artifact = exportWinccPackage({ schema, revision: 4 })
  const files = zipEntries(Buffer.from(artifact.contentBase64, 'base64'))
  const manifest = JSON.parse(files.get('manifest.json'))
  assert.equal(manifest.format, 'scamatic-wincc-unified/v2')
  assert.equal(manifest.source.revision, 4)
  assert.equal('tags' in manifest, false)
  assert.equal('dataSources' in manifest, false)
  assert.equal(files.get('manifest.json').includes('legacy-tag'), false)
  assert.equal(files.get('manifest.json').includes('private.source'), false)
  assert.equal(artifact.componentCount, 4)
  assert.equal(artifact.graphicCount, 1)
  assert.equal(manifest.screen.items.find(item => item.kind === 'control-button').text, 'Open panel')
  assert.equal(manifest.screen.items.find(item => item.kind === 'gauge').value, 42)
  assert.equal(manifest.screen.items.find(item => item.kind === 'indicator-lamp').color, '#91abee')
  const graphic = manifest.screen.items.find(item => item.kind === 'industrial-graphic')
  assert.match(files.get(graphic.file), /<svg\b/)
  assert.ok(files.has('assets/grindstone/LICENSE.txt'))
  assert.match(files.get('scripts/wincc-template.js'), /HMIRuntime\.Trace\("Button tapped: Open panel"\)/)
  assert.deepEqual(schema, original)

  function widget(type, properties) {
    const component = createComponentInstance(type, { id: type, index: schema.components.length, canvas: schema.project.canvas })
    component.properties = { ...component.properties, ...properties }
    schema.components.push(component)
    return component
  }
})

function zipEntries(zip) {
  const files = new Map()
  let offset = 0
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedLength = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + compressedLength
    files.set(zip.toString('utf8', nameStart, nameStart + nameLength), inflateRawSync(zip.subarray(dataStart, dataEnd)).toString('utf8'))
    offset = dataEnd
  }
  return files
}
