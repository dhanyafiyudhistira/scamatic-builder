import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { BSON } from 'mongodb'
import { ProjectVersion } from '../api/_lib/models.js'
import { createProjectSchema } from '../shared/project-schema.js'
import { createComponentInstance } from '../shared/component-registry.js'
import { createDeployment, digestJson, sha256 } from '../hosted-runtime/contract.js'
import { sanitizeSvg } from '../api/_lib/svg.js'
import { exportRuntimePackage, runtimePackageFiles } from '../hosted-runtime/export-package.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'target/runtime-export-smoke')
mkdirSync(output, { recursive: true })
for (const projectType of ['iot-dashboard', 'scada']) {
  for (const profile of ['monitor', 'simulation']) {
    const projectId = `trial-${projectType}-${profile}`
    const schema = createProjectSchema({ id: projectId, name: 'Runtime Export Trial', slug: `runtime-export-${projectType}-${profile}-trial`, projectType })
    schema.project.runtimeProfile = profile
    schema.dataSources = [{ id: 'tb', type: 'thingsboard', connectorRef: 'trial-connector', environmentRef: 'production' }]
    schema.components = [createComponentInstance(projectType === 'scada' ? 'pump' : 'text-label', { id: 'main', canvas: schema.project.canvas })]
    if (profile === 'simulation') {
      schema.tags = [{ id: 'running', name: 'Running', sourceId: 'tb', path: 'Running', dataType: 'boolean', access: 'read-write', initialValue: false }]
      schema.components.push(createComponentInstance('control-button', { id: 'start-button', canvas: schema.project.canvas, tagId: 'running', index: 1 }))
    }
    const assets = []
    if (projectType === 'scada') {
      const clean = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><path d="M100 200h800" stroke="cyan" /></svg>')
      schema.project.svgAssetId = 'trial-schematic'
      assets.push({ _id: 'trial-schematic', projectId, kind: 'svg', content: clean.svg, checksum: sha256(clean.svg), byteLength: clean.byteLength })
    }
    const version = { _id: `${projectId}-v1`, projectId, version: 1, schema, checksum: digestJson(schema), assetId: schema.project.svgAssetId, assetChecksum: assets[0]?.checksum }
    const record = new ProjectVersion({ ...version, validationSummary: { issues: [] }, draftRevision: 1, idempotencyKey: 'runtime-export-smoke', createdBy: 'smoke-publisher' })
    const stored = BSON.deserialize(BSON.serialize(record.toBSON()))
    assert.equal(digestJson(stored.schema), stored.checksum)
    const deployment = createDeployment({ project: { _id: projectId, security: { pinEnabled: false } }, version: stored, assets, connectors: [{ id: 'trial-connector', environmentRef: 'production', config: { serverUrl: 'https://thingsboard.example.com', deviceId: 'CONFIGURE-A-REAL-DEVICE' } }] })
    for (const target of ['node', 'vercel']) {
      const files = runtimePackageFiles(root, deployment, target)
      const names = [...files.keys()]
      assert.ok(names.includes('dist/index.html'))
      assert.ok(names.includes('hosted-runtime/server.js'))
      assert.equal(names.some(name => /BuilderPlatform|BuilderPanels|ProjectDraft\.jsx|src\/main|api\/_handlers\/(draft|publish|projects|elements|signup|runtime-export)\./.test(name)), false)
      assert.ok(names.includes('api/_handlers/commands.js'))
      assert.ok(names.includes('api/_handlers/simulation-sequence.js'))
      const lock = JSON.parse(files.get('package-lock.json'))
      assert.equal(Object.keys(lock.packages).some(name => /tauri|vite|react/.test(name)), false)
      const snapshot = JSON.parse(files.get('deployment.json'))
      assert.equal(snapshot.payload.project.projectType, projectType)
      assert.equal(snapshot.payload.version.schema.project.svgAssetId, schema.project.svgAssetId)
      assert.deepEqual(snapshot.payload.assets, deployment.payload.assets)
      assert.equal(snapshot.policy, profile === 'simulation' ? 'simulation' : 'monitor-only')
      if (profile === 'simulation') assert.deepEqual(snapshot.payload.connectors, [])
      const exported = exportRuntimePackage(root, deployment, target)
      writeFileSync(resolve(output, exported.fileName), Buffer.from(exported.contentBase64, 'base64'))
      console.log(`Verified ${projectType} ${profile} ${target} package: ${files.size} files, ${exported.bytes} bytes, SHA-256 ${exported.sha256}`)
    }
  }
}
console.log(`Trial ZIPs (example projects, not live devices): ${output}`)
