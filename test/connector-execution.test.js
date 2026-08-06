import test from 'node:test'
import assert from 'node:assert/strict'
import { connectorEnvironmentReadiness, connectorExecutionMode, usesServerlessConnectorExecution } from '../api/_lib/connector-execution.js'

test('Vercel defaults connector execution to serverless without affecting local workers', () => {
  assert.equal(connectorExecutionMode({ VERCEL: '1' }), 'serverless')
  assert.equal(connectorExecutionMode({}), 'worker')
  assert.equal(usesServerlessConnectorExecution({ VERCEL: '1' }), true)
})

test('an explicit connector execution mode overrides platform detection', () => {
  assert.equal(connectorExecutionMode({ VERCEL: '1', CONNECTOR_EXECUTION_MODE: 'worker' }), 'worker')
  assert.equal(connectorExecutionMode({ CONNECTOR_EXECUTION_MODE: 'serverless' }), 'serverless')
  assert.equal(connectorExecutionMode({ CONNECTOR_EXECUTION_MODE: 'invalid' }), 'worker')
})

test('serverless readiness does not require a continuously running worker heartbeat', () => {
  const staleOnlineEnvironment = {
    secretConfiguredAt: new Date(1),
    health: { state: 'online', checkedAt: new Date(1) },
  }
  assert.deepEqual(connectorEnvironmentReadiness(staleOnlineEnvironment, {
    executionMode: 'serverless',
    now: 100_000,
  }), { ready: true, reason: 'online' })
  assert.deepEqual(connectorEnvironmentReadiness(staleOnlineEnvironment, {
    executionMode: 'worker',
    now: 100_000,
  }), { ready: false, reason: 'heartbeat' })
})

test('all execution modes still require a configured secret and online health', () => {
  assert.deepEqual(connectorEnvironmentReadiness({
    health: { state: 'online', checkedAt: new Date() },
  }, { executionMode: 'serverless' }), { ready: false, reason: 'secret' })
  assert.deepEqual(connectorEnvironmentReadiness({
    secretConfiguredAt: new Date(),
    health: { state: 'degraded', checkedAt: new Date() },
  }, { executionMode: 'serverless' }), { ready: false, reason: 'health' })
})
