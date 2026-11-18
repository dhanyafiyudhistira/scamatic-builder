import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { COMPONENT_REGISTRY, createComponentInstance, componentAvailableForProject } from '../shared/component-registry.js'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.argv[2] || resolve(root, `target/egui-builder/debug/scamatic-egui-builder${process.platform === 'win32' ? '.exe' : ''}`)
const folder = mkdtempSync(join(tmpdir(), 'scamatic-egui-compat-'))
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const read = file => JSON.parse(readFileSync(file, 'utf8'))
let checks = 0
const markupTools = ['line', 'arrow', 'rectangle', 'rounded', 'ellipse', 'text', 'pencil', 'curve', 'double-arrow', 'triangle', 'diamond', 'polygon', 'star']
function run(...args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${args[0]}: ${result.stderr || result.stdout}`)
}
function valid(schema) {
  assert.deepEqual(validateProjectSchema(schema, { requireAsset: schema.project.projectType === 'scada' }).filter(issue => issue.severity === 'error'), [])
}

try {
  for (const projectType of ['scada', 'iot-dashboard']) {
    const schema = createProjectSchema({ id: `${projectType}-compat`, name: 'Compatibility fixture', slug: `${projectType}-compat`, projectType, width: 1200, height: 760 })
    if (projectType === 'scada') schema.project.svgAssetId = 'fixture-svg'
    schema.tags = [
      { id: 'status', name: 'Status', sourceId: 'source_mock', path: 'Status', dataType: 'boolean', access: 'read' },
      { id: 'level', name: 'Level', sourceId: 'source_mock', path: 'Level', dataType: 'number', access: 'read', engineering: { min: 0, max: 100, unit: '%', decimals: 1 } },
    ]
    for (const [type, definition] of Object.entries(COMPONENT_REGISTRY)) {
      if (!componentAvailableForProject(type, projectType) || definition.library === false) continue
      const component = createComponentInstance(type, { id: type, canvas: schema.project.canvas, index: schema.components.length })
      component.position = { ...component.position, x: 100, y: 100, width: 200, height: 120, rotation: 25 }
      if (projectType === 'iot-dashboard') component.responsivePositions = { mobile: { x: 5, y: 10, width: 280, height: 100, rotation: 0 } }
      component.metadata = { empty: {}, futureProperty: { order: ['z', 'a'], nested: null } }
      schema.components.push(component)
    }
    schema.futureExtension = { preserve: {}, decimal: 0.123456789012345, largeInteger: 9007199254740991 }
    valid(schema)
    const assets = [{ _id: 'fixture-svg', kind: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 760"/>', metadata: { mimeType: 'image/svg+xml' } }]
    for (const [format, input, expected] of [
      ['raw', schema, schema],
      ['draft', { schema, assets, futureEnvelope: { empty: {} } }, { schema, assets, futureEnvelope: { empty: {} } }],
      ['deployment', { format: 'scamatic-runtime-bundle/v1', payload: { version: { schema, checksum: 'source-only' }, assets } }, { format: 'scamatic-egui-draft/v1', schema, assets }],
    ]) {
      const file = join(folder, `${projectType}-${format}.json`)
      const output = `${file}.copy.json`
      writeFileSync(file, JSON.stringify(input))
      const originalDigest = digest(file)
      run('--validate', file)
      run('--roundtrip', file, output)
      assert.deepEqual(read(output), expected)
      assert.equal(digest(file), originalDigest)
      checks++
      // Markup stays in the draft envelope so every shared runtime schema remains valid.
      let markupInput = file
      let markupDraft
      for (const tool of markupTools) {
        const annotated = `${file}.${tool}.json`
        run('--add-markup', markupInput, annotated, `markup-${tool}`, '100', '100', '300', '200')
        markupDraft = read(annotated)
        if (tool === 'pencil') {
          markupDraft.markup.objects.at(-1).properties.points = [[0, 1], [0.3, 0.25], [0.6, 0.8], [1, 0]]
          writeFileSync(annotated, JSON.stringify(markupDraft))
          run('--validate', annotated)
        }
        assert.deepEqual(markupDraft.schema, schema)
        valid(markupDraft.schema)
        assert.equal(markupDraft.markup.format, 'scamatic-markup/v1')
        assert.equal(markupDraft.markup.objects.at(-1).type, `markup-${tool}`)
        if (format !== 'raw') assert.deepEqual(markupDraft.assets, expected.assets)
        if (format === 'draft') assert.deepEqual(markupDraft.futureEnvelope, expected.futureEnvelope)
        assert.equal(digest(file), originalDigest)
        markupInput = annotated
        checks++
      }
      assert.equal(markupDraft.markup.objects.length, markupTools.length)
      const markupCopy = `${file}.markup-copy.json`
      run('--roundtrip', markupInput, markupCopy)
      assert.deepEqual(read(markupCopy), markupDraft)
      checks++
      const markupMoved = `${file}.markup-moved.json`
      run('--transform', markupInput, markupMoved, markupDraft.markup.objects[0].id, '40', '20')
      const expectedMoved = structuredClone(markupDraft)
      Object.assign(expectedMoved.markup.objects[0].position, { x: 140, y: 120 })
      assert.deepEqual(read(markupMoved), expectedMoved)
      checks++
      const markupResized = `${file}.markup-resized.json`
      run('--transform', markupInput, markupResized, markupDraft.markup.objects[0].id, '50', '-200', 'resize')
      const expectedResized = structuredClone(markupDraft)
      Object.assign(expectedResized.markup.objects[0].position, { width: 250, height: 1 })
      assert.deepEqual(read(markupResized), expectedResized)
      checks++
      const transformed = `${file}.moved.json`
      const id = schema.components[0].id
      run('--transform', file, transformed, id, '40', '20')
      const moved = structuredClone(expected)
      const movedSchema = moved.schema || moved
      Object.assign(movedSchema.components[0].position, { x: 140, y: 120 })
      assert.deepEqual(read(transformed), moved)
      valid(movedSchema)
      assert.equal(digest(file), originalDigest)
      checks++
      const resized = `${file}.resized.json`
      run('--transform', file, resized, id, '50', '30', 'resize')
      const expectedResize = structuredClone(expected)
      Object.assign((expectedResize.schema || expectedResize).components[0].position, { width: 250, height: 150 })
      assert.deepEqual(read(resized), expectedResize)
      valid(expectedResize.schema || expectedResize)
      checks++
      const overwrite = spawnSync(executable, ['--roundtrip', file, file], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
      assert.equal(overwrite.status, 1)
      assert.equal(digest(file), originalDigest)
      checks++
    }
  }
  const invalid = join(folder, 'invalid.json')
  for (const asset of ['demo-project.json', 'demo-iot-project.json']) {
    const example = resolve(root, 'builder-egui/assets', asset)
    const copy = join(folder, `${asset}.copy.json`)
    const expected = read(example)
    valid(expected.schema)
    run('--validate', example)
    run('--roundtrip', example, copy)
    assert.deepEqual(read(copy), expected)
    checks++
  }
  writeFileSync(invalid, '{"schemaVersion":"1.8.0"}')
  assert.equal(spawnSync(executable, ['--validate', invalid], { windowsHide: true, timeout: 30_000 }).status, 1)
  checks++
  console.log(`Passed ${checks} egui compatibility checks: SCADA + IoT, raw/draft/deployment, all ${markupTools.length} markup tools, freehand paths, lossless save/move/resize, unknown fields/assets/responsive layouts, source protection and malformed input.`)
} finally {
  // mkdtempSync creates this private test directory; no user input contributes to it.
  assert.ok(folder.startsWith(join(tmpdir(), 'scamatic-egui-compat-')))
  rmSync(folder, { recursive: true, force: true })
}
