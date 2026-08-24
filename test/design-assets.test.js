import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareDesignAsset, publicDesignAssets, referencedDesignAssetIds } from '../api/_lib/design-assets.js'
import { createComponentInstance } from '../shared/component-registry.js'
import { createProjectSchema, validateProjectSchema } from '../shared/project-schema.js'

const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='

test('custom PNG assets are verified, measured, and exposed as project-scoped URLs', () => {
  const prepared = prepareDesignAsset({ fileName: 'pump.png', mimeType: 'image/png', content: onePixelPng })
  assert.equal(prepared.kind, 'design-image')
  assert.equal(prepared.metadata.width, 1)
  assert.equal(prepared.metadata.height, 1)
  const assets = publicDesignAssets([{ _id: 'asset-1', projectId: 'project-1', ...prepared }])
  assert.equal(assets['asset-1'].src, '/api/elements?projectId=project-1&assetId=asset-1')
})

test('custom SVG assets are sanitized before becoming canvas elements', () => {
  const prepared = prepareDesignAsset({ fileName: 'tank.svg', mimeType: 'image/svg+xml', content: '<svg viewBox="0 0 80 40"><rect width="80" height="40"/></svg>' })
  assert.equal(prepared.metadata.width, 80)
  assert.equal(prepared.metadata.height, 40)
  assert.throws(() => prepareDesignAsset({ fileName: 'bad.svg', mimeType: 'image/svg+xml', content: '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>' }))
})

test('design image components publish without tag bindings and retain asset references', () => {
  const schema = createProjectSchema({ id: 'project-1', name: 'Plant', slug: 'plant', width: 800, height: 600 })
  schema.project.svgAssetId = 'base-svg'
  const image = createComponentInstance('design-image', { id: 'image-1', canvas: schema.project.canvas })
  image.properties.assetId = 'asset-1'
  schema.components.push(image)
  assert.deepEqual(referencedDesignAssetIds(schema), ['asset-1'])
  assert.deepEqual(validateProjectSchema(schema, { requireAsset: true }), [])
})

test('custom asset uploads reject spoofed raster formats', () => {
  assert.throws(
    () => prepareDesignAsset({ fileName: 'fake.jpg', mimeType: 'image/jpeg', content: onePixelPng }),
    /does not match/,
  )
})
