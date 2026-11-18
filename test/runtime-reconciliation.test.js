import test from 'node:test'
import assert from 'node:assert/strict'
import { loadRuntimeReconciliationInputs } from '../server/connectors/runtime-reconciliation.js'

test('runtime reconciliation batches connector state and queries sessions only when lifecycle decisions need them', async () => {
  const calls = { environments: 0, projects: 0, versions: 0, drafts: 0, sessions: 0 }
  const connectors = [
    connector('always', 'project-always'),
    connector('smart-published', 'project-smart-published'),
    connector('smart-draft', 'project-smart-draft'),
    connector('demand', 'project-demand'),
  ]
  const projects = [
    project('project-always', 'always-on', 'version-always'),
    project('project-smart-published', 'smart', 'version-smart'),
    project('project-smart-draft', 'smart', null),
    project('project-demand', 'on-demand', 'version-demand'),
  ]

  const result = await loadRuntimeReconciliationInputs({
    connectors,
    environmentRef: 'staging',
    findEnvironments: async ids => {
      calls.environments += 1
      assert.deepEqual(ids, ['always', 'smart-published', 'smart-draft', 'demand'])
      return connectors.map(item => ({ _id: `environment-${item._id}`, connectorId: item._id, environmentRef: 'staging' }))
    },
    findProjects: async ids => { calls.projects += 1; assert.equal(ids.length, 4); return projects },
    findVersions: async ids => {
      calls.versions += 1
      assert.deepEqual(ids, ['version-always', 'version-smart', 'version-demand'])
      return ids.map(_id => ({ _id, schema: {} }))
    },
    findDrafts: async ids => {
      calls.drafts += 1
      assert.deepEqual(ids, ['project-smart-draft'])
      return [{ _id: 'project-smart-draft', revision: 2, schema: {} }]
    },
    findActiveSessionProjectIds: async ids => {
      calls.sessions += 1
      assert.deepEqual(ids, ['project-smart-draft', 'project-demand'])
      return ['project-demand']
    },
    selectRuntimeSchema: ({ publishedVersion, draft }) => publishedVersion
      ? { mode: 'published', fingerprint: String(publishedVersion._id) }
      : draft ? { mode: 'bootstrap', fingerprint: String(draft.revision) } : null,
  })

  assert.deepEqual(calls, { environments: 1, projects: 1, versions: 1, drafts: 1, sessions: 1 })
  assert.equal(result.items.length, 4)
  assert.equal(result.items.find(item => item.connector._id === 'smart-draft').selection.mode, 'bootstrap')
  assert.deepEqual([...result.activeProjectIds], ['project-demand'])
})

test('runtime reconciliation skips every database loader when no enabled connector exists', async () => {
  let calls = 0
  const loader = async () => { calls += 1; return [] }
  const result = await loadRuntimeReconciliationInputs({
    connectors: [],
    findEnvironments: loader,
    findProjects: loader,
    findVersions: loader,
    findDrafts: loader,
    findActiveSessionProjectIds: loader,
    selectRuntimeSchema: () => null,
  })
  assert.equal(calls, 0)
  assert.deepEqual(result.items, [])
  assert.equal(result.activeProjectIds.size, 0)
})

function connector(_id, projectId) {
  return { _id, projectId, workspaceId: 'workspace-1', type: 'thingsboard' }
}

function project(_id, runtimeWorkerMode, activeVersionId) {
  return { _id, workspaceId: 'workspace-1', runtimeWorkerMode, activeVersionId }
}
