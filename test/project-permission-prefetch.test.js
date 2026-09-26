import test from 'node:test'
import assert from 'node:assert/strict'
import { PERMISSIONS, requireProjectPermission } from '../api/_lib/authorization.js'

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

test('prefetched project assignment authorizes an operator without another database lookup', async () => {
  const principal = { id: 'user-1', workspaceId: 'workspace-1', role: 'OPERATOR' }
  const project = { id: 'project-1', workspaceId: 'workspace-1', security: { pinEnabled: false } }
  const result = await requireProjectPermission(
    principal,
    responseRecorder(),
    project,
    PERMISSIONS.COMMAND_EXECUTE,
    { projectAssignment: { projectId: 'project-1', userId: 'user-1', role: 'OPERATOR', status: 'active' } },
  )

  assert.equal(result.effectiveRole, 'OPERATOR')
  assert.equal(result.capabilities.includes(PERMISSIONS.COMMAND_EXECUTE), true)
})

test('a prefetched missing assignment fails closed instead of issuing a fallback lookup', async () => {
  const response = responseRecorder()
  const result = await requireProjectPermission(
    { id: 'user-1', workspaceId: 'workspace-1', role: 'OPERATOR' },
    response,
    { id: 'project-1', workspaceId: 'workspace-1', security: { pinEnabled: false } },
    PERMISSIONS.COMMAND_EXECUTE,
    { projectAssignment: null },
  )

  assert.equal(result, null)
  assert.equal(response.statusCode, 404)
})
