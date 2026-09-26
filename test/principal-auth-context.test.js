import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPrincipalContext } from '../api/_lib/auth.js'

test('principal authentication joins the live user and workspace membership in one MongoDB command', async () => {
  const now = new Date('2026-09-22T00:00:00.000Z')
  const expected = {
    _id: 'session-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    user: { _id: 'user-1', authVersion: 2 },
    membership: { workspaceId: 'workspace-1', userId: 'user-1', role: 'OPERATOR' },
  }
  let calls = 0
  let pipeline
  const authSessions = {
    async aggregate(value) {
      calls += 1
      pipeline = value
      return [expected]
    },
  }

  const result = await loadPrincipalContext({
    sessionId: 'session-1',
    now,
    authSessions,
    users: { collection: { name: 'scadausers' } },
    workspaceMembers: { collection: { name: 'scadaworkspacemembers' } },
  })

  assert.equal(calls, 1)
  assert.equal(result, expected)
  assert.deepEqual(pipeline[0], { $match: { _id: 'session-1', revokedAt: null, expiresAt: { $gt: now } } })
  assert.deepEqual(pipeline.filter(stage => stage.$lookup).map(stage => stage.$lookup.from), ['scadausers', 'scadaworkspacemembers'])
  assert.equal(JSON.stringify(pipeline).includes('passwordHash'), false)
})

test('principal authentication fails closed when the aggregate finds no live context', async () => {
  const result = await loadPrincipalContext({
    sessionId: 'missing-session',
    authSessions: { aggregate: async () => [] },
    users: { collection: { name: 'scadausers' } },
    workspaceMembers: { collection: { name: 'scadaworkspacemembers' } },
  })
  assert.equal(result, null)
})
