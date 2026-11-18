import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { inflateRawSync } from 'node:zlib'
import { BSON } from 'mongodb'
import { ProjectDraft, ProjectVersion } from '../api/_lib/models.js'
import { createProjectSchema, migrateProjectSchema } from '../shared/project-schema.js'
import { createComponentInstance } from '../shared/component-registry.js'
import { createDeployment, digestJson, verifyDeployment, exportRuntimeSchema, sha256 } from '../hosted-runtime/contract.js'
import { createZip } from '../hosted-runtime/zip.js'
import { runtimeRequestAllowed, createRuntimeApp } from '../hosted-runtime/app.js'
import { provisioningInput } from '../hosted-runtime/provision.js'
import { prepareDesignAsset } from '../api/_lib/design-assets.js'
import { sanitizeSvg } from '../api/_lib/svg.js'
import { runtimeCommandExecutionPlan } from '../shared/runtime-profile.js'
import { executeMockCommand } from '../shared/runtime-evaluator.js'
import { hostedRuntimeProfile } from '../shared/hosted-runtime-policy.js'
import { buildSimulationSequencePlan, resolveSimulationSequenceStep } from '../shared/simulation-sequence.js'

function fixture(projectType = 'iot-dashboard') {
  const projectId = projectType === 'scada' ? 'project-scada' : 'project-iot'
  const schema = createProjectSchema({ id: projectId, name: 'Fleet', slug: 'fleet', projectType })
  schema.project.runtimeProfile = 'monitor'
  schema.dataSources = [{ id: 'tb', type: 'thingsboard', connectorRef: 'connector-a', environmentRef: 'production' }]
  schema.components = [createComponentInstance('text-label', { id: 'label', canvas: schema.project.canvas })]
  const project = { _id: projectId, security: { pinEnabled: false } }
  const version = { _id: 'version-one', projectId: project._id, version: 1, schema, checksum: digestJson(schema) }
  const assets = []
  if (projectType === 'scada') {
    const clean = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><path id="pipe-main" d="M10 20h400" stroke="blue" /></svg>')
    assets.push({ _id: 'schematic-one', projectId, kind: 'svg', content: clean.svg, checksum: sha256(clean.svg), byteLength: clean.byteLength })
    schema.project.svgAssetId = version.assetId = 'schematic-one'
    version.assetChecksum = assets[0].checksum
    schema.components = ['pump', 'pipe', 'motor', 'valve', 'fan', 'control-popup'].map((type, index) => createComponentInstance(type, { id: type, canvas: schema.project.canvas, index }))
    version.checksum = digestJson(schema)
  }
  return { project, version, assets, connectors: [{ id: 'connector-a', environmentRef: 'production', config: { serverUrl: 'https://tb.example.com', deviceId: 'device-a' } }] }
}

function persistedPublication(input, { legacyMinimize = false } = {}) {
  const snapshot = migrateProjectSchema(input.version.schema)
  const record = new ProjectVersion({ ...input.version, schema: snapshot, checksum: digestJson(snapshot), validationSummary: { issues: [] }, idempotencyKey: 'checksum-regression', draftRevision: 1, createdBy: 'publisher' })
  const wireRecord = legacyMinimize ? record.toObject({ minimize: true }) : record.toBSON()
  return BSON.deserialize(BSON.serialize(wireRecord))
}

function simulationFixture(projectType = 'iot-dashboard', sourceType = 'mock') {
  const input = fixture(projectType)
  const schema = input.version.schema
  schema.project.runtimeProfile = 'simulation'
  schema.dataSources = [{ id: 'tb', type: sourceType, connectorRef: sourceType === 'mock' ? null : 'connector-a', environmentRef: 'production' }]
  schema.tags = [{ id: 'running', name: 'Running', sourceId: 'tb', path: 'Running', dataType: 'boolean', access: 'read-write', initialValue: false }]
  schema.tags.push(
    { id: 'level', name: 'Level', sourceId: 'tb', path: 'Level', dataType: 'number', access: 'read-write', initialValue: 0, engineering: { min: 0, max: 100, unit: '', decimals: 0 }, writeConstraints: { min: 0, max: 100, step: 1 } },
    { id: 'mode', name: 'Mode', sourceId: 'tb', path: 'Mode', dataType: 'string', access: 'read-write', initialValue: 'manual' },
  )
  const button = createComponentInstance('control-button', { id: 'start-button', canvas: schema.project.canvas, tagId: 'running' })
  button.properties.rpcMethod = 'setRunning'
  schema.components.push(button)
  const slider = createComponentInstance('tuning-slider', { id: 'level-slider', canvas: schema.project.canvas, tagId: 'level', index: 1 })
  slider.properties.rpcMethod = 'setLevel'
  const operation = createComponentInstance('operation-shifter', { id: 'operation', canvas: schema.project.canvas, tagId: 'mode', index: 2 })
  operation.properties.controlledComponentIds = ['start-button', 'level-slider']
  operation.properties.autoSequence = [{ id: 'start-unit', componentId: 'start-button', value: true, delayMs: 500, enabled: true }]
  schema.components.push(slider, operation)
  input.version.checksum = digestJson(schema)
  input.connectors = []
  return input
}

for (const projectType of ['scada', 'iot-dashboard']) {
  test(`${projectType} published checksum survives actual Mongoose/BSON serialization before export`, () => {
    const input = fixture(projectType)
    input.version.schema.components[0].metadata = { layout: {}, note: 'preserved' }
    const expected = migrateProjectSchema(input.version.schema)
    const draft = new ProjectDraft({ _id: input.project._id, schema: expected, updatedBy: 'publisher' })
    assert.deepEqual(BSON.deserialize(BSON.serialize(draft.toBSON())).schema, expected)
    const stored = persistedPublication(input)
    assert.deepEqual(stored.schema, expected)
    assert.equal(digestJson(stored.schema), stored.checksum)
    const reloaded = ProjectVersion.hydrate(stored).toObject()
    assert.equal(digestJson(reloaded.schema), reloaded.checksum)
    const deployment = createDeployment({ ...input, version: stored })
    assert.equal(deployment.payload.version.sourceChecksum, stored.checksum)
    assert.equal(verifyDeployment(deployment), deployment)
  })

  test(`${projectType} legacy minimized publication exports only after reconstructing its exact original checksum`, () => {
    const input = fixture(projectType)
    const stored = persistedPublication(input, { legacyMinimize: true })
    const unchanged = structuredClone(stored)
    assert.notEqual(digestJson(stored.schema), stored.checksum)
    assert.equal(stored.schema.components[0].metadata, undefined)
    const deployment = createDeployment({ ...input, version: stored })
    assert.equal(deployment.payload.version.sourceChecksum, stored.checksum)
    assert.equal(verifyDeployment(deployment), deployment)
    assert.deepEqual(stored, unchanged)
    stored.schema.components[0].name = 'Changed after publication'
    assert.throws(() => createDeployment({ ...input, version: stored }), { code: 'PUBLISHED_SCHEMA_CHECKSUM_MISMATCH' })
  })

  test(`${projectType} exported simulation retains slider behavior and selected AUTO recipe steps`, () => {
    const { schema } = createDeployment(simulationFixture(projectType)).payload.version
    const slider = schema.components.find(item => item.id === 'level-slider')
    const tag = schema.tags.find(item => item.id === 'level')
    const tuned = executeMockCommand(slider, tag, 0, 40, { components: schema.components })
    assert.equal(tuned.ok, true)
    assert.equal(tuned.value, 40)
    assert.equal(slider.properties.simulationRampPerSecond, 0.1)
    const operation = schema.components.find(item => item.id === 'operation')
    const mode = schema.tags.find(item => item.id === 'mode')
    const auto = executeMockCommand(operation, mode, 'manual', { mode: 'auto', enabledStepIds: ['start-unit'] }, { components: schema.components })
    assert.equal(auto.ok, true)
    assert.equal(auto.value.mode, 'auto')
    assert.equal(buildSimulationSequencePlan(schema, 'operation', ['start-unit']).steps[0].componentId, 'start-button')
    assert.deepEqual(resolveSimulationSequenceStep(schema, 'operation', 'start-unit', ['start-unit']).changes, { running: true })
  })
}

test('legacy repair rejects unknown lost fields and gives republish guidance instead of replacing the checksum', () => {
  const input = fixture()
  input.version.schema.components[0].metadata = { unknownEmptyField: {} }
  const stored = persistedPublication(input, { legacyMinimize: true })
  assert.throws(() => createDeployment({ ...input, version: stored }), error => error.code === 'PUBLISHED_SCHEMA_CHECKSUM_MISMATCH' && /publish a new version/i.test(error.message))
})

test('runtime export is bound to a published IoT snapshot and strips arbitrary metadata', () => {
  const input = fixture()
  input.version.schema.components[0].metadata = { token: 'LOCAL_SECRET_NOT_FOR_EXPORT' }
  input.version.schema.dataSources[0].metadata = { password: 'SOURCE_PASSWORD' }
  input.version.schema.project.privateNote = 'LOCAL_NOTE'
  input.version.checksum = digestJson(input.version.schema)
  const deployment = createDeployment(input)
  assert.equal(deployment.payload.version.sourceChecksum, input.version.checksum)
  assert.equal(deployment.policy, 'monitor-only')
  assert.equal(JSON.stringify(deployment).includes('LOCAL_SECRET'), false)
  assert.equal(JSON.stringify(deployment).includes('SOURCE_PASSWORD'), false)
  assert.equal(JSON.stringify(deployment).includes('LOCAL_NOTE'), false)
  assert.equal(verifyDeployment(deployment), deployment)
  deployment.payload.version.schema.project.name = 'tampered'
  assert.throws(() => verifyDeployment(deployment), /checksum/)
})

test('runtime export rejects unknown project types, corrupted publication and unsafe component fields', () => {
  const input = fixture()
  input.version.schema.project.projectType = 'unknown'
  assert.throws(() => exportRuntimeSchema(input.version.schema), /SCADA or IoT/)
  input.version.schema.project.projectType = 'iot-dashboard'
  input.version.schema.components[0].properties.token = 'secret'
  assert.throws(() => exportRuntimeSchema(input.version.schema), /unsupported export property/)
  assert.throws(() => createDeployment(input), /checksum/)
})

for (const projectType of ['scada', 'iot-dashboard']) {
  test(`${projectType} simulation exports with mock or ThingsBoard tag mappings and needs no upstream secrets`, () => {
    for (const sourceType of ['mock', 'thingsboard']) {
      const input = simulationFixture(projectType, sourceType)
      const stored = persistedPublication(input)
      const deployment = createDeployment({ ...input, version: stored })
      assert.equal(deployment.policy, 'simulation')
      assert.equal(deployment.payload.version.schema.project.runtimeProfile, 'simulation')
      assert.equal(deployment.payload.version.schema.dataSources[0].type, sourceType)
      assert.deepEqual(deployment.payload.connectors, [])
      assert.equal(deployment.payload.version.sourceChecksum, stored.checksum)
      assert.equal(runtimeCommandExecutionPlan(deployment.payload.version.schema, { sourceType, serverlessAvailable: true }).executionMode, 'mock')
      const environment = { SCADA_ADMIN_EMAIL: 'operator@example.com', SCADA_ADMIN_PASSWORD: 'simulation-pass-123', MONGO_URI: 'mongodb://target.example/simulation', APP_ORIGIN: 'https://simulation.example.com', NODE_ENV: 'production' }
      const inputConfig = provisioningInput(deployment, environment)
      assert.equal(inputConfig.role, 'OPERATOR')
      assert.deepEqual(inputConfig.capabilities, ['runtime.view', 'command.execute'])
      assert.deepEqual(inputConfig.secrets, [])
      assert.equal(verifyDeployment(deployment), deployment)
      deployment.policy = 'monitor-only'
      assert.throws(() => verifyDeployment(deployment), /policy/)
    }
  })
}

test('hosted simulation commands cannot be enabled for REAL PLC or an unrecognized deployment policy', () => {
  assert.equal(hostedRuntimeProfile({ id: 'simulation', commandEnabled: true }, 'simulation').commandEnabled, true)
  assert.equal(hostedRuntimeProfile({ id: 'simulation', commandEnabled: true }, undefined).commandEnabled, false)
  assert.equal(hostedRuntimeProfile({ id: 'real', commandEnabled: true }, 'simulation').commandEnabled, false)
  assert.equal(hostedRuntimeProfile({ id: 'real', commandEnabled: true }, 'monitor-only').commandEnabled, false)
})

test('simulation router permits scoped controls, AUTO steps and runtime chart archive only', () => {
  const deployment = createDeployment(simulationFixture())
  const body = { projectId: deployment.payload.project.id }
  assert.equal(runtimeRequestAllowed(deployment, 'commands', 'POST', {}, body), true)
  assert.equal(runtimeRequestAllowed(deployment, 'commands', 'POST', {}, { projectId: 'other' }), false)
  assert.equal(runtimeRequestAllowed(deployment, 'simulation-sequence', 'POST', {}, { ...body, action: 'start' }), true)
  assert.equal(runtimeRequestAllowed(deployment, 'simulation-sequence', 'POST', {}, { ...body, action: 'step' }), true)
  assert.equal(runtimeRequestAllowed(deployment, 'simulation-sequence', 'POST', {}, { ...body, action: 'configure' }), false)
  assert.equal(runtimeRequestAllowed(deployment, 'telemetry', 'POST', {}, { ...body, source: 'runtime-simulation' }), true)
  assert.equal(runtimeRequestAllowed(deployment, 'telemetry', 'POST', {}, { ...body, source: 'external' }), false)
  assert.equal(runtimeRequestAllowed(deployment, 'runtime-telemetry', 'GET', body), false)
  for (const route of ['draft', 'publish', 'signup', 'simulator', 'connectors', 'settings']) assert.equal(runtimeRequestAllowed(deployment, route, 'POST', {}, body), false)
})

test('hosted simulation HTTP exposes operator controls and local telemetry while retaining the editor boundary', async t => {
  const deployment = createDeployment(simulationFixture())
  let commandCount = 0
  const schema = deployment.payload.version.schema
  const app = createRuntimeApp({ deployment, root: process.cwd(), handlers: {
    auth: (req, res) => res.json({ user: { role: 'OWNER', capabilities: ['project.manage'], workspaces: ['private'] } }),
    runtime: (req, res) => res.json({ schema, profile: { id: 'simulation', commandEnabled: true } }),
    'runtime-session': (req, res) => res.json({ token: 'simulation-runtime-token', profile: { id: 'simulation', commandEnabled: true }, telemetry: { mode: 'simulation', bridge: { available: true } }, stream: { url: 'wss://upstream.example.com' } }),
    commands: (req, res) => {
      commandCount++
      const component = schema.components.find(item => item.id === req.body.componentId)
      const result = executeMockCommand(component, schema.tags[0], false, true, { components: schema.components })
      res.json({ ...result, executionMode: 'mock', status: 'acknowledged' })
    },
  } })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const auth = await (await fetch(base + '/api/auth')).json()
  assert.equal(auth.user.role, 'OPERATOR')
  assert.deepEqual(auth.user.capabilities, ['runtime.view', 'command.execute'])
  assert.equal(auth.user.workspaces, undefined)
  const runtime = await (await fetch(base + '/api/runtime?slug=fleet')).json()
  assert.equal(runtime.profile.commandEnabled, true)
  assert.equal(runtime.deployment.policy, 'simulation')
  const session = await (await post('/api/runtime-session', { projectId: 'project-iot' })).json()
  assert.equal(session.telemetry.bridge.available, false)
  assert.equal(session.stream, null)
  const command = await (await post('/api/commands', { projectId: 'project-iot', componentId: 'start-button' })).json()
  assert.equal(command.ok, true)
  assert.equal(command.value, true)
  assert.equal(command.executionMode, 'mock')
  assert.equal(commandCount, 1)
  assert.equal((await post('/api/commands', { projectId: 'other', componentId: 'start-button' })).status, 404)
  assert.equal(commandCount, 1)
  assert.equal((await post('/api/publish', { projectId: 'project-iot' })).status, 404)
})

test('SCADA export preserves the published schematic, process components, positions and source profile', () => {
  const input = fixture('scada')
  input.version.schema.project.runtimeProfile = 'real'
  input.version.checksum = digestJson(input.version.schema)
  const deployment = createDeployment(input)
  assert.equal(deployment.payload.project.projectType, 'scada')
  assert.match(deployment.deploymentId, /^scada-/)
  assert.equal(deployment.policy, 'monitor-only')
  assert.equal(deployment.payload.version.schema.project.runtimeProfile, 'real')
  assert.deepEqual(deployment.payload.version.schema.components, input.version.schema.components.map(({ metadata, ...component }) => component))
  assert.equal(deployment.payload.assets[0].content, input.assets[0].content)
  assert.equal(deployment.payload.assets[0].checksum, input.version.assetChecksum)
  assert.equal(verifyDeployment(deployment), deployment)
  deployment.payload.project.projectType = 'iot-dashboard'
  deployment.payloadChecksum = digestJson(deployment.payload)
  assert.throws(() => verifyDeployment(deployment), /identity/)
})

test('SCADA export requires the exact published SVG, not a missing, changed or design-image asset', () => {
  const input = fixture('scada')
  input.version.schema.project.svgAssetId = null
  assert.throws(() => exportRuntimeSchema(input.version.schema), /SVG asset is required/)
  input.version.schema.project.svgAssetId = 'schematic-one'
  assert.throws(() => createDeployment({ ...input, assets: [] }), /asset is missing/)
  assert.throws(() => createDeployment({ ...input, version: { ...input.version, assetId: 'other' } }), /schematic identity/)
  assert.throws(() => createDeployment({ ...input, version: { ...input.version, assetChecksum: 'changed' } }), /schematic checksum/)
  input.assets[0].kind = 'design-image'
  assert.throws(() => createDeployment(input), /sanitized SVG/)
})

test('asset export carries only referenced sanitized assets and rejects tampering', () => {
  const input = fixture()
  input.version.schema.components = [createComponentInstance('design-image', { id: 'image', canvas: input.version.schema.project.canvas })]
  input.version.schema.components[0].properties.assetId = 'image-a'
  input.version.checksum = digestJson(input.version.schema)
  const prepared = prepareDesignAsset({ fileName: 'diagram.svg', mimeType: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="10" height="10" /></svg>' })
  const deployment = createDeployment({ ...input, assets: [{ _id: 'image-a', projectId: input.project._id, ...prepared }, { _id: 'unused', projectId: input.project._id, content: 'PRIVATE_UNUSED_CONTENT' }] })
  assert.equal(deployment.payload.assets.length, 1)
  assert.equal(JSON.stringify(deployment).includes('PRIVATE_UNUSED_CONTENT'), false)
  assert.equal(verifyDeployment(deployment), deployment)
  deployment.payload.assets[0].content += '<script>bad()</script>'
  assert.throws(() => verifyDeployment(deployment), /checksum/)
})

test('export preserves responsive positions and telemetry freshness semantics', () => {
  const input = fixture()
  input.version.schema.components[0].responsivePositions = { mobile: { x: 5, y: 10, width: 180, height: 80, rotation: 0 } }
  input.version.schema.tags = [{ id: 'mode', name: 'Mode', path: 'Mode', sourceId: 'tb', access: 'read', dataType: 'boolean', freshnessMode: 'event-driven', adaptiveFreshness: false, staleAfterMs: 15000 }]
  input.version.checksum = digestJson(input.version.schema)
  const { schema } = createDeployment(input).payload.version
  assert.deepEqual(schema.components[0].responsivePositions, input.version.schema.components[0].responsivePositions)
  assert.equal(schema.tags[0].freshnessMode, 'event-driven')
  assert.equal(schema.tags[0].adaptiveFreshness, false)
})

test('connector export keeps only the target descriptor and requires credentials to be reconfigured', () => {
  const input = fixture()
  input.version.schema.dataSources = [{ id: 'tb', type: 'thingsboard', connectorRef: 'connector-a', environmentRef: 'production' }]
  input.version.checksum = digestJson(input.version.schema)
  const connectors = [{ id: 'connector-a', environmentRef: 'production', config: { serverUrl: 'https://tb.example.com', deviceId: 'device-a', jwt: 'LOCAL_JWT', password: 'LOCAL_PASSWORD' } }]
  const deployment = createDeployment({ ...input, connectors })
  assert.deepEqual(deployment.payload.connectors[0].config, { serverUrl: 'https://tb.example.com', deviceId: 'device-a' })
  assert.equal(JSON.stringify(deployment).includes('LOCAL_'), false)
  connectors[0].config.serverUrl = 'https://user:password@tb.example.com'
  assert.throws(() => createDeployment({ ...input, connectors }), /credential/)
})

test('runtime router permits scoped reads and rejects all editor/command methods even before a handler runs', () => {
  const deployment = createDeployment(fixture())
  const query = { projectId: 'project-iot' }
  assert.equal(runtimeRequestAllowed(deployment, 'runtime', 'GET', { slug: 'fleet' }), true)
  assert.equal(runtimeRequestAllowed(deployment, 'runtime-session', 'POST', {}, query), true)
  assert.equal(runtimeRequestAllowed(deployment, 'runtime-session', 'POST', {}, { projectId: 'other' }), false)
  for (const route of ['draft', 'publish', 'signup', 'connectors', 'settings', 'runtime-export', 'simulator', 'versions', 'constructor', '__proto__', 'toString']) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) assert.equal(runtimeRequestAllowed(deployment, route, method, query, query), false)
  }
  assert.equal(runtimeRequestAllowed(deployment, 'commands', 'POST', {}, query), false)
  assert.equal(runtimeRequestAllowed(deployment, 'projects', 'PATCH', {}, { ...query, action: 'delete' }), false)
  assert.equal(runtimeRequestAllowed(deployment, 'projects', 'PATCH', {}, { ...query, action: 'unlock', pin: '246809' }), true)
  assert.equal(runtimeRequestAllowed(deployment, 'runtime', 'GET', { slug: 'fleet', workspaceId: 'other' }), false)
})

test('hosted HTTP surface does not expose the editor or package data and lowers capabilities', async t => {
  const deployment = createDeployment(fixture())
  let reads = 0
  const app = createRuntimeApp({ deployment, root: process.cwd(), handlers: {
    runtime: (req, res) => { reads++; res.json({ profile: { id: 'real', commandEnabled: true }, capabilities: ['project.manage', 'command.execute'] }) },
    auth: (req, res) => res.json({ user: { role: 'OWNER', capabilities: ['project.manage'], workspaces: ['private'] } }),
  } })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  for (const path of ['/api/draft', '/api/publish', '/api/signup', '/deployment.json', '/runtime-manifest.json', '/api/runtime?slug=other']) assert.equal((await fetch(base + path)).status, 404)
  assert.equal(reads, 0)
  const response = await fetch(base + '/api/runtime?slug=fleet')
  const payload = await response.json()
  assert.equal(payload.profile.commandEnabled, false)
  assert.deepEqual(payload.capabilities, ['runtime.view'])
  const auth = await (await fetch(base + '/api/auth')).json()
  assert.deepEqual(auth.user.capabilities, ['runtime.view'])
  assert.equal(auth.user.workspaces, undefined)
  assert.equal((await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'project-iot' }) })).status, 404)
})

test('provisioning requires target-only credentials and exact origin without using desktop sessions', () => {
  const deployment = createDeployment(fixture())
  assert.throws(() => provisioningInput(deployment, {}), /SCADA_ADMIN/)
  const environment = { SCADA_ADMIN_EMAIL: 'viewer@example.com', SCADA_ADMIN_PASSWORD: 'trial-password-123', MONGO_URI: 'mongodb://target.example/runtime', APP_ORIGIN: 'https://fleet.example.com', NODE_ENV: 'production', SCADA_CONNECTOR_MASTER_KEY: 'a'.repeat(64), CONNECTOR_ALLOWED_HOSTS: 'tb.example.com', RUNTIME_THINGSBOARD_CREDENTIALS: JSON.stringify({ 'connector-a': { jwt: 'target.jwt.only' } }) }
  assert.equal(provisioningInput(deployment, environment).email, 'viewer@example.com')
  assert.equal(provisioningInput(deployment, { ...environment, RUNTIME_THINGSBOARD_CREDENTIALS: '{}' }, new Set(['connector-a:production'])).secrets[0].secret, undefined)
  assert.throws(() => provisioningInput(deployment, { ...environment, APP_ORIGIN: 'https://fleet.example.com/path' }), /APP_ORIGIN/)
  deployment.payload.project.pinRequired = true
  deployment.payloadChecksum = digestJson(deployment.payload)
  assert.throws(() => provisioningInput(deployment, environment), /SCADA_RUNTIME_PIN/)
})

test('hosted SCADA HTTP reads retain the schematic while commands and asset leaks remain blocked', async t => {
  const deployment = createDeployment(fixture('scada'))
  const app = createRuntimeApp({ deployment, root: process.cwd(), handlers: {
    runtime: (req, res) => res.json({ schema: deployment.payload.version.schema, svg: deployment.payload.assets[0].content, profile: { id: 'monitor', commandEnabled: true } }),
  } })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const info = await (await fetch(base + '/api/runtime-info')).json()
  assert.equal(info.projectType, 'scada')
  const runtime = await (await fetch(base + '/api/runtime?slug=fleet')).json()
  assert.equal(runtime.schema.project.projectType, 'scada')
  assert.equal(runtime.svg, deployment.payload.assets[0].content)
  assert.equal(runtime.profile.commandEnabled, false)
  assert.equal((await fetch(base + '/api/elements?projectId=project-scada&assetId=schematic-one')).status, 404)
  assert.equal((await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'project-scada' }) })).status, 404)
})

test('runtime ZIP is interoperable DEFLATE and rejects traversal entries', () => {
  const archive = createZip(new Map([['DEPLOY.md', 'trial instructions'], ['api/[route].js', 'export default () => {}']]))
  assert.equal(archive.readUInt32LE(0), 0x04034b50)
  const nameLength = archive.readUInt16LE(26)
  const compressedSize = archive.readUInt32LE(18)
  const content = inflateRawSync(archive.subarray(30 + nameLength, 30 + nameLength + compressedSize)).toString()
  assert.ok(['trial instructions', 'export default () => {}'].includes(content))
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50)
  assert.throws(() => createZip(new Map([['../secret', 'bad']])), /Unsafe/)
})
