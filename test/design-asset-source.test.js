import assert from 'node:assert/strict'
import test from 'node:test'
import { connectedDesignAssetPath, hydrateConnectedDesignAssets } from '../shared/design-asset-source.js'

test('desktop design asset paths remain project and asset scoped', () => {
  assert.equal(
    connectedDesignAssetPath('/api/elements?projectId=project-123&assetId=asset-456'),
    '/api/elements?projectId=project-123&assetId=asset-456',
  )
  assert.equal(connectedDesignAssetPath('https://foreign.example/api/elements?projectId=project-123&assetId=asset-456'), null)
  assert.equal(connectedDesignAssetPath('/api/runtime?projectId=project-123&assetId=asset-456'), null)
  assert.equal(connectedDesignAssetPath('/api/elements?projectId=project-123&assetId=asset-456&raw=1'), null)
  assert.equal(connectedDesignAssetPath('/api/elements?projectId=project/123&assetId=asset-456'), null)
})

test('desktop design assets hydrate through the authenticated source loader', async () => {
  const original = {
    'asset-456': {
      id: 'asset-456',
      name: 'pump.png',
      mimeType: 'image/png',
      src: '/api/elements?projectId=project-123&assetId=asset-456',
    },
  }
  const loaded = []
  const hydrated = await hydrateConnectedDesignAssets(original, async path => {
    loaded.push(path)
    return 'data:image/png;base64,AQID'
  })

  assert.deepEqual(loaded, ['/api/elements?projectId=project-123&assetId=asset-456'])
  assert.equal(hydrated['asset-456'].src, 'data:image/png;base64,AQID')
  assert.equal(hydrated['asset-456'].name, 'pump.png')
  assert.equal(original['asset-456'].src, '/api/elements?projectId=project-123&assetId=asset-456')
})
