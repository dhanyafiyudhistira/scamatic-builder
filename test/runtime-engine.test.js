import test from 'node:test'
import assert from 'node:assert/strict'
import { Project, RuntimeSession, RuntimeStreamSession } from '../api/_lib/models.js'
import {
  ISAAC_RUNTIME_ENGINE,
  STANDARD_RUNTIME_ENGINE,
  applyIsaacCanarySelection,
  isaacCanarySelected,
  resolveRuntimeEngine,
  runtimeEngine,
  runtimeEngineMetadata,
  validRuntimeEngine,
} from '../shared/runtime-engine.js'
import { standardRuntimeEnginesMatch } from '../server/connectors/runtime-stream-hub.js'

test('runtime engine values default closed to Standard', () => {
  assert.equal(runtimeEngine(null), STANDARD_RUNTIME_ENGINE)
  assert.equal(runtimeEngine({}), STANDARD_RUNTIME_ENGINE)
  assert.equal(runtimeEngine({ runtimeEnginePreference: 'unknown' }), STANDARD_RUNTIME_ENGINE)
  assert.equal(runtimeEngine({ engine: 'ISAAC' }), ISAAC_RUNTIME_ENGINE)
  assert.equal(validRuntimeEngine('standard'), true)
  assert.equal(validRuntimeEngine('isaac'), true)
  assert.equal(validRuntimeEngine('future-engine'), false)
})

test('Isaac preference falls back to Standard until the gateway is explicitly available', () => {
  assert.deepEqual(resolveRuntimeEngine({ runtimeEnginePreference: 'isaac' }), {
    requested: ISAAC_RUNTIME_ENGINE,
    selected: STANDARD_RUNTIME_ENGINE,
    fallbackReason: 'ISAAC_UNAVAILABLE',
  })
  assert.deepEqual(resolveRuntimeEngine({ runtimeEnginePreference: 'isaac' }, { isaacAvailable: true }), {
    requested: ISAAC_RUNTIME_ENGINE,
    selected: ISAAC_RUNTIME_ENGINE,
    fallbackReason: null,
  })
  assert.equal(runtimeEngineMetadata('isaac').label, 'ISAAC · FAST RUNTIME')
})

test('new persistence records use Standard while legacy records remain compatible', () => {
  const project = new Project({ workspaceId: 'workspace', name: 'Engine test', slug: 'engine-test', createdBy: 'owner', updatedBy: 'owner' })
  const runtime = new RuntimeSession({ _id: 'runtime', authSessionId: 'auth', userId: 'user', workspaceId: 'workspace', projectId: 'project', versionId: 'version', expiresAt: new Date(Date.now() + 60_000) })
  const stream = new RuntimeStreamSession({ _id: 'stream', runtimeSessionId: 'runtime', userId: 'user', workspaceId: 'workspace', projectId: 'project', versionId: 'version', expiresAt: new Date(Date.now() + 60_000) })

  assert.equal(project.runtimeEnginePreference, STANDARD_RUNTIME_ENGINE)
  assert.equal(project.isaacCanaryEnabled, false)
  assert.equal(runtime.engine, STANDARD_RUNTIME_ENGINE)
  assert.equal(stream.engine, STANDARD_RUNTIME_ENGINE)
  assert.equal(standardRuntimeEnginesMatch({}, {}), true)
  assert.equal(standardRuntimeEnginesMatch({ engine: 'standard' }, { engine: 'standard' }), true)
  assert.equal(standardRuntimeEnginesMatch({ engine: 'isaac' }, { engine: 'isaac' }), false)
  assert.equal(standardRuntimeEnginesMatch({ engine: 'standard' }, { engine: 'isaac' }), false)
})

test('Isaac canary selection atomically aligns project eligibility and engine preference', () => {
  const project = { runtimeEnginePreference: STANDARD_RUNTIME_ENGINE, isaacCanaryEnabled: false }
  assert.equal(isaacCanarySelected(project), false)

  applyIsaacCanarySelection(project, true)
  assert.equal(project.runtimeEnginePreference, ISAAC_RUNTIME_ENGINE)
  assert.equal(project.isaacCanaryEnabled, true)
  assert.equal(isaacCanarySelected(project), true)

  applyIsaacCanarySelection(project, false)
  assert.equal(project.runtimeEnginePreference, STANDARD_RUNTIME_ENGINE)
  assert.equal(project.isaacCanaryEnabled, false)
  assert.equal(isaacCanarySelected(project), false)
})
