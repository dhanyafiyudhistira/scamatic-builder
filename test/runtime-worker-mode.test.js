import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Project } from '../api/_lib/models.js'
import {
  DEFAULT_RUNTIME_WORKER_MODE,
  RUNTIME_WORKER_MODES,
  runtimeWorkerMode,
  runtimeWorkerModeMetadata,
  shouldRunProjectWorker,
  validRuntimeWorkerMode,
} from '../shared/runtime-worker-mode.js'

test('runtime worker mode is bounded and defaults legacy projects to Smart', () => {
  assert.deepEqual(RUNTIME_WORKER_MODES, ['smart', 'always-on', 'on-demand'])
  assert.equal(runtimeWorkerMode({}), DEFAULT_RUNTIME_WORKER_MODE)
  assert.equal(runtimeWorkerMode({ runtimeWorkerMode: ' ALWAYS-ON ' }), 'always-on')
  assert.equal(runtimeWorkerMode({ runtimeWorkerMode: 'unexpected' }), 'smart')
  assert.equal(validRuntimeWorkerMode('on-demand'), true)
  assert.equal(validRuntimeWorkerMode('disabled'), false)
  assert.equal(runtimeWorkerModeMetadata('smart').label, 'SMART')
  assert.equal(Project.schema.path('runtimeWorkerMode').options.default, 'smart')
})

test('runtime worker lifecycle preserves background operation without making every draft permanent', () => {
  const now = Date.parse('2026-09-06T02:00:00.000Z')
  assert.equal(shouldRunProjectWorker({ runtimeWorkerMode: 'always-on' }), true)
  assert.equal(shouldRunProjectWorker({ runtimeWorkerMode: 'on-demand' }), false)
  assert.equal(shouldRunProjectWorker({ runtimeWorkerMode: 'on-demand' }, { hasActiveSession: true }), true)
  assert.equal(shouldRunProjectWorker({ runtimeWorkerMode: 'smart' }, { selectionMode: 'published', now }), true)
  assert.equal(shouldRunProjectWorker({ runtimeWorkerMode: 'smart' }, { selectionMode: 'bootstrap', draftUpdatedAt: '2026-09-06T01:45:00.000Z', now }), true)
  assert.equal(shouldRunProjectWorker({ runtimeWorkerMode: 'smart' }, { selectionMode: 'bootstrap', draftUpdatedAt: '2026-09-05T23:00:00.000Z', now }), false)
  assert.equal(shouldRunProjectWorker({ runtimeWorkerMode: 'smart' }, { hasActiveSession: true, selectionMode: 'bootstrap', draftUpdatedAt: '2026-09-05T23:00:00.000Z', now }), true)
})

test('Builder replaces the Isaac rollout setup with audited runtime worker modes', async () => {
  const [builder, styles, projectsHandler] = await Promise.all([
    readFile(new URL('../src/BuilderPlatform.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/builder.css', import.meta.url), 'utf8'),
    readFile(new URL('../api/_handlers/projects.js', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(builder, /Isaac runtime setup/)
  assert.match(builder, />Runtime worker mode</)
  assert.match(builder, /set-runtime-worker-mode/)
  assert.match(builder, /RUNTIME_WORKER_MODES\.map/)
  assert.match(builder, /locked && <small>Unlock the project/)
  assert.doesNotMatch(builder, /const metadata = runtimeWorkerModeMetadata\(mode\)/)
  assert.match(styles, /sb-create-modal\.sb-isaac-setup-modal[\s\S]*font-family: Inter, ui-sans-serif/)
  assert.match(styles, /sb-isaac-info-button[\s\S]*font: 900 12px\/1 Inter, ui-sans-serif/)
  assert.match(styles, /sb-runtime-worker-mode-select[\s\S]*font: 800 9px\/1 Inter, ui-sans-serif/)
  assert.match(projectsHandler, /project\.runtime-worker-mode\.updated/)
  assert.match(projectsHandler, /onRuntimeWorkerModeChanged/)
  assert.doesNotMatch(projectsHandler, /action === 'set-isaac-canary'/)
})
