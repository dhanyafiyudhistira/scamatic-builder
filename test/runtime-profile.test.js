import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runtimeAllowsCommands,
  runtimeCommandExecutionPlan,
  runtimeProfile,
  runtimeProfileMetadata,
  runtimeUsesLiveTelemetry,
} from '../shared/runtime-profile.js'
import { createProjectSchema, migrateProjectSchema, validateProjectSchema } from '../shared/project-schema.js'

test('new projects default to an isolated browser simulation profile', () => {
  const schema = createProjectSchema({ id: 'new-project', name: 'New Project', slug: 'new-project' })
  assert.equal(runtimeProfile(schema), 'simulation')
  assert.equal(runtimeAllowsCommands(schema), true)
  assert.equal(runtimeUsesLiveTelemetry(schema), false)
  assert.equal(runtimeProfileMetadata(schema).label, 'SIMULATION')
})

test('legacy projects infer real mode from a live data source', () => {
  const schema = createProjectSchema({ id: 'legacy-live', name: 'Legacy Live', slug: 'legacy-live' })
  schema.schemaVersion = '1.3.0'
  delete schema.project.runtimeProfile
  schema.dataSources.push({
    id: 'source_tb',
    type: 'thingsboard',
    environmentRef: 'staging',
    connectorRef: 'connector-1',
  })
  const migrated = migrateProjectSchema(schema)
  assert.equal(migrated.project.runtimeProfile, 'real')
  assert.equal(runtimeUsesLiveTelemetry(migrated), true)
})

test('monitor profile keeps live telemetry but blocks every command', () => {
  const schema = createProjectSchema({ id: 'monitor', name: 'Monitor', slug: 'monitor' })
  schema.project.runtimeProfile = 'monitor'
  schema.dataSources.push({
    id: 'source_tb',
    type: 'thingsboard',
    environmentRef: 'staging',
    connectorRef: 'connector-1',
  })
  assert.equal(runtimeAllowsCommands(schema), false)
  assert.equal(runtimeUsesLiveTelemetry(schema), true)
  assert.deepEqual(runtimeCommandExecutionPlan(schema, { sourceType: 'thingsboard', serverlessAvailable: true }), {
    executionMode: null,
    initialStatus: null,
  })
})

test('real and monitor profiles require a live source', () => {
  for (const profile of ['real', 'monitor']) {
    const schema = createProjectSchema({ id: `project-${profile}`, name: profile, slug: profile })
    schema.project.runtimeProfile = profile
    const issues = validateProjectSchema(schema)
    assert.ok(issues.some(issue => issue.code === 'profile.liveSource'))
  }
})

test('real controls cannot bind to mock tags', () => {
  const schema = createProjectSchema({ id: 'real-control', name: 'Real Control', slug: 'real-control' })
  schema.project.runtimeProfile = 'real'
  schema.dataSources.push({
    id: 'source_tb',
    type: 'thingsboard',
    environmentRef: 'staging',
    connectorRef: 'connector-1',
  })
  schema.tags.push({
    id: 'mock.command',
    name: 'Mock command',
    path: 'mock_command',
    dataType: 'boolean',
    access: 'write',
    sourceId: 'source_mock',
  })
  schema.components.push({
    id: 'mock-control',
    type: 'control-button',
    name: 'Mock control',
    position: { x: 0, y: 0, width: 120, height: 60, rotation: 0 },
    binding: { tagId: 'mock.command' },
    properties: { action: 'toggle-boolean', ackTimeoutMs: 5000 },
  })
  const issues = validateProjectSchema(schema)
  assert.ok(issues.some(issue => issue.code === 'command.profileSource'))
})

test('serverless real commands start dispatched so a worker cannot claim them', () => {
  const schema = createProjectSchema({ id: 'real-plan', name: 'Real Plan', slug: 'real-plan' })
  schema.project.runtimeProfile = 'real'
  assert.deepEqual(runtimeCommandExecutionPlan(schema, {
    sourceType: 'thingsboard',
    serverlessAvailable: true,
  }), {
    executionMode: 'serverless',
    initialStatus: 'dispatched',
  })
  assert.deepEqual(runtimeCommandExecutionPlan(schema, {
    sourceType: 'thingsboard',
    serverlessAvailable: false,
  }), {
    executionMode: 'worker',
    initialStatus: 'requested',
  })
})
