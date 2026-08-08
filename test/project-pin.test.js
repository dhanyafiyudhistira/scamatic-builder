import test from 'node:test'
import assert from 'node:assert/strict'
import { hashProjectPin, projectPinError, projectSecuritySnapshot, projectUnlockId, projectUnlockPolicy, verifyProjectPin } from '../api/_lib/project-pin.js'
import { PERMISSIONS, requireProjectPermission } from '../api/_lib/authorization.js'
import { ProjectUnlockSession } from '../api/_lib/models.js'

test('project PIN validation requires a confirmed non-trivial six-digit value', () => {
  assert.match(projectPinError('12345'), /exactly 6 digits/)
  assert.match(projectPinError('12a456'), /exactly 6 digits/)
  assert.match(projectPinError('582941', '582942'), /confirmation/)
  assert.match(projectPinError('111111'), /same digit/)
  assert.match(projectPinError('123456'), /simple sequence/)
  assert.match(projectPinError('654321'), /simple sequence/)
  assert.match(projectPinError('582582'), /same three digits/)
  assert.equal(projectPinError('582941', '582941'), null)
})

test('project PIN hashing is salted, verifiable, and never stores plaintext', async () => {
  const first = await hashProjectPin('582941')
  const second = await hashProjectPin('582941')
  assert.notEqual(first, second)
  assert.equal(first.includes('582941'), false)
  assert.equal(await verifyProjectPin('582941', first), true)
  assert.equal(await verifyProjectPin('582942', first), false)
})

test('project unlock policy defaults to eight hours and enforces safe bounds', () => {
  assert.deepEqual(projectUnlockPolicy({}), { ttlMs: 8 * 60 * 60 * 1000 })
  assert.deepEqual(projectUnlockPolicy({ SCADA_PROJECT_UNLOCK_SECONDS: '1' }), { ttlMs: 5 * 60 * 1000 })
  assert.deepEqual(projectUnlockPolicy({ SCADA_PROJECT_UNLOCK_SECONDS: '999999' }), { ttlMs: 12 * 60 * 60 * 1000 })
  assert.deepEqual(projectUnlockPolicy({ SCADA_PROJECT_UNLOCK_SECONDS: '1800' }), { ttlMs: 30 * 60 * 1000 })
})

test('project unlock keys are deterministic and scoped to both sessions and projects', () => {
  const key = projectUnlockId('session-a', 'project-a')
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.equal(projectUnlockId('session-a', 'project-a'), key)
  assert.notEqual(projectUnlockId('session-b', 'project-a'), key)
  assert.notEqual(projectUnlockId('session-a', 'project-b'), key)
})

test('project security snapshots expose state without secret material', () => {
  const project = { security: { pinEnabled: true, pinHash: 'secret-hash', pinVersion: 7, pinConfiguredAt: new Date('2026-08-07T00:00:00.000Z') } }
  assert.deepEqual(projectSecuritySnapshot(project, false), { pinEnabled: true, unlocked: false, pinConfiguredAt: project.security.pinConfiguredAt })
  assert.equal('pinHash' in projectSecuritySnapshot(project, true), false)
  assert.deepEqual(projectSecuritySnapshot({ security: { pinEnabled: false } }), { pinEnabled: false, unlocked: true, pinConfiguredAt: null })
})

test('project authorization returns 423 until the current auth session unlocks the matching PIN version', async t => {
  const originalExists = ProjectUnlockSession.exists
  t.after(() => { ProjectUnlockSession.exists = originalExists })
  const principal = { id: 'user-a', sessionId: 'session-a', workspaceId: 'workspace-a', role: 'OWNER' }
  const project = { _id: 'project-a', id: 'project-a', workspaceId: 'workspace-a', security: { pinEnabled: true, pinVersion: 3 } }
  const response = responseRecorder()
  let observedQuery = null
  ProjectUnlockSession.exists = async query => { observedQuery = query; return null }

  assert.equal(await requireProjectPermission(principal, response, project, PERMISSIONS.BUILDER_READ), null)
  assert.equal(response.statusCode, 423)
  assert.deepEqual(response.body, { error: 'Project PIN is required.', code: 'PROJECT_LOCKED', projectId: 'project-a' })
  assert.equal(observedQuery.authSessionId, 'session-a')
  assert.equal(observedQuery.projectId, 'project-a')
  assert.equal(observedQuery.pinVersion, 3)

  ProjectUnlockSession.exists = async () => ({ _id: 'unlock-session' })
  const authorized = await requireProjectPermission(principal, responseRecorder(), project, PERMISSIONS.BUILDER_READ)
  assert.equal(authorized.effectiveRole, 'OWNER')
})

test('project-lock bypass is explicit and does not query unlock state', async t => {
  const originalExists = ProjectUnlockSession.exists
  t.after(() => { ProjectUnlockSession.exists = originalExists })
  let unlockQueries = 0
  ProjectUnlockSession.exists = async () => { unlockQueries += 1; return null }
  const principal = { id: 'user-a', sessionId: 'session-a', workspaceId: 'workspace-a', role: 'OWNER' }
  const project = { _id: 'project-a', id: 'project-a', workspaceId: 'workspace-a', security: { pinEnabled: true, pinVersion: 3 } }

  const authorized = await requireProjectPermission(
    principal,
    responseRecorder(),
    project,
    PERMISSIONS.RUNTIME_VIEW,
    { bypassProjectLock: true },
  )
  assert.equal(authorized.effectiveRole, 'OWNER')
  assert.equal(unlockQueries, 0)
})

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this },
    json(value) { this.body = value; return this },
  }
}
