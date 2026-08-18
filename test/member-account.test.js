import test from 'node:test'
import assert from 'node:assert/strict'
import { memberAccountAvailability, memberDirectoryEntries, memberMutationError } from '../api/_handlers/members.js'

const activeUser = {
  _id: 'user-a',
  email: 'operator@example.com',
  displayName: 'Plant Operator',
  status: 'active',
}

test('a missing identity is available as a new account and requires credentials', () => {
  assert.deepEqual(memberAccountAvailability(null, null, ' New@Example.com '), {
    state: 'new_account',
    code: 'NEW_ACCOUNT',
    email: 'new@example.com',
    displayName: '',
    exists: false,
    available: true,
    passwordRequired: true,
    message: 'No account found. A new account will be created.',
  })
})

test('an active identity without a workspace membership can be linked without new credentials', () => {
  const result = memberAccountAvailability(activeUser, null)
  assert.equal(result.state, 'available')
  assert.equal(result.available, true)
  assert.equal(result.passwordRequired, false)
  assert.equal(result.displayName, 'Plant Operator')
})

test('an existing active workspace member cannot be added twice', () => {
  const result = memberAccountAvailability(activeUser, { status: 'active' })
  assert.equal(result.state, 'already_member')
  assert.equal(result.available, false)
  assert.equal(result.code, 'ALREADY_WORKSPACE_MEMBER')
})

test('a disabled workspace membership must be reactivated instead of duplicated', () => {
  const result = memberAccountAvailability(activeUser, { status: 'disabled' })
  assert.equal(result.state, 'membership_disabled')
  assert.equal(result.available, false)
  assert.equal(result.code, 'WORKSPACE_MEMBERSHIP_DISABLED')
})

test('a globally disabled account is never available for workspace linking', () => {
  const result = memberAccountAvailability({ ...activeUser, status: 'disabled' }, null)
  assert.equal(result.state, 'account_disabled')
  assert.equal(result.available, false)
  assert.equal(result.code, 'ACCOUNT_DISABLED')
})

test('member directory keeps project assignments isolated per user', () => {
  const createdAt = new Date('2026-08-19T00:00:00.000Z')
  const result = memberDirectoryEntries(
    [
      { userId: 'user-a', role: 'OPERATOR', status: 'active', createdAt },
      { userId: 'user-b', role: 'VIEWER', status: 'active', createdAt },
      { userId: 'user-c', role: 'EDITOR', status: 'active', createdAt },
    ],
    [
      activeUser,
      { _id: 'user-b', email: 'viewer@example.com', displayName: 'Plant Viewer' },
      { _id: 'user-c', email: 'editor@example.com', displayName: 'Plant Editor' },
    ],
    [
      { userId: 'user-a', projectId: 'project-1' },
      { userId: 'user-a', projectId: 'project-2' },
      { userId: 'user-b', projectId: 'project-2' },
    ]
  )

  assert.deepEqual(result.map(member => ({ id: member.id, projectIds: member.projectIds })), [
    { id: 'user-a', projectIds: ['project-1', 'project-2'] },
    { id: 'user-b', projectIds: ['project-2'] },
    { id: 'user-c', projectIds: [] },
  ])
})

test('an administrator cannot mutate an existing owner through the member endpoint', () => {
  assert.deepEqual(memberMutationError({
    actorId: 'admin-a',
    actorRole: 'ADMIN',
    targetUserId: 'owner-a',
    targetRole: 'OWNER',
    nextRole: 'VIEWER',
    nextStatus: 'disabled',
  }), {
    status: 403,
    code: 'OWNER_REQUIRED',
    message: 'Only the owner can perform this member change.',
  })
})

test('owner protection still allows ordinary administrator project updates', () => {
  assert.equal(memberMutationError({
    actorId: 'admin-a',
    actorRole: 'ADMIN',
    targetUserId: 'operator-a',
    targetRole: 'OPERATOR',
    nextRole: 'OPERATOR',
    nextStatus: 'active',
  }), null)
})

test('an active owner cannot demote or disable their own membership', () => {
  const input = {
    actorId: 'owner-a',
    actorRole: 'OWNER',
    targetUserId: 'owner-a',
    targetRole: 'OWNER',
    nextRole: 'OWNER',
  }
  assert.equal(memberMutationError({ ...input, nextStatus: 'active' }), null)
  assert.equal(memberMutationError({ ...input, nextStatus: 'disabled' })?.code, 'ACTIVE_OWNER_REQUIRED')
  assert.equal(memberMutationError({ ...input, nextRole: 'ADMIN', nextStatus: 'active' })?.code, 'ACTIVE_OWNER_REQUIRED')
})
