import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnectorHandler } from '../api/_handlers/connectors.js'

const principal = { id: 'editor-1', workspaceId: 'workspace-1', role: 'EDITOR' }
const project = { id: 'project-1', _id: 'project-1', workspaceId: principal.workspaceId }
const oldDeviceId = 'a1523ea0-65f2-11ee-8c99-0242ac120002'
const newDeviceId = 'b1523ea0-65f2-11ee-8c99-0242ac120002'

test('ThingsBoard action handler enforces project permission and CSRF before dispatch', async () => {
  let actionCalls = 0
  let connectCalls = 0
  const authenticationResponse = mockResponse()
  await runHandler(actionRequest('browse-devices'), authenticationResponse, {
    ...outerDependencies(),
    requirePrincipal: async (_req, res) => {
      res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' })
      return null
    },
    connectMongo: async () => { connectCalls += 1 },
    handleConnectorAction: async () => { actionCalls += 1 },
  })
  assert.equal(authenticationResponse.statusCode, 401)
  assert.equal(connectCalls, 0)
  assert.equal(actionCalls, 0)

  const permissionResponse = mockResponse()
  await runHandler(actionRequest('browse-devices'), permissionResponse, {
    ...outerDependencies(),
    requireProjectPermission: async (_principal, res) => {
      res.status(403).json({ error: 'Insufficient permission.', code: 'PERMISSION_DENIED' })
      return null
    },
    handleConnectorAction: async () => { actionCalls += 1 },
  })
  assert.equal(permissionResponse.statusCode, 403)
  assert.equal(actionCalls, 0)

  const csrfResponse = mockResponse()
  await runHandler(actionRequest('browse-devices'), csrfResponse, {
    ...outerDependencies(),
    requireCsrf: (_req, res) => {
      res.status(403).json({ error: 'Invalid CSRF token.', code: 'CSRF_INVALID' })
      return false
    },
    handleConnectorAction: async () => { actionCalls += 1 },
  })
  assert.equal(csrfResponse.statusCode, 403)
  assert.equal(actionCalls, 0)
})

test('action-specific rate limiting blocks device selection before an upstream request', async () => {
  const calls = []
  const response = mockResponse()
  await runHandler(actionRequest('select-device', { deviceId: newDeviceId }), response, actionDependencies({
    calls,
    connector: connectorRecord(),
    environment: environmentRecord(calls),
    enforceRateLimit: async (_req, res, scope) => {
      calls.push(`rate.${scope}`)
      if (scope !== 'connector-select-device') return true
      res.status(429).json({ error: 'Too many requests.', code: 'RATE_LIMITED' })
      return false
    },
    getThingsBoardDevice: async () => {
      calls.push('catalog.lookup')
      return { id: newDeviceId }
    },
  }))

  assert.equal(response.statusCode, 429)
  assert.deepEqual(calls.filter(value => typeof value === 'string' && value.startsWith('rate.')), ['rate.connector-write', 'rate.connector-select-device'])
  assert.equal(calls.includes('catalog.lookup'), false)
})

test('device selection commits configuration and audit in one handler transaction', async () => {
  const calls = []
  const connector = connectorRecord()
  const environment = environmentRecord(calls)
  const session = { id: 'device-selection-session' }
  const response = mockResponse()

  await runHandler(actionRequest('select-device', { deviceId: newDeviceId }), response, actionDependencies({
    calls,
    connector,
    environment,
    runMongoTransaction: async work => {
      calls.push('transaction.begin')
      const result = await work(session)
      calls.push('transaction.commit')
      return result
    },
    audit: async (_principal, _projectId, action, _targetId, metadata, activeSession) => {
      assert.equal(activeSession, session)
      assert.equal(action, 'connector.device.selected')
      assert.equal(metadata.deviceId, newDeviceId)
      calls.push('audit.save')
    },
  }))

  assert.equal(response.statusCode, 200)
  assert.equal(environment.config.deviceId, newDeviceId)
  assert.deepEqual(environment.savedWith, { session })
  assert.ok(calls.indexOf('environment.save') < calls.indexOf('audit.save'))
  assert.ok(calls.indexOf('audit.save') < calls.indexOf('transaction.commit'))
  assert.deepEqual(calls.filter(value => typeof value === 'string' && value.startsWith('rate.')), ['rate.connector-write', 'rate.connector-select-device'])
  const payload = JSON.stringify(response.body)
  assert.doesNotMatch(payload, /private-jwt|"password"|"refreshToken":/i)
})

test('an audit failure rolls back device selection and returns a closed handler error', async () => {
  const calls = []
  const connector = connectorRecord()
  const environment = environmentRecord(calls)
  const response = mockResponse()
  const snapshot = environmentSnapshot(environment)

  await runHandler(actionRequest('select-device', { deviceId: newDeviceId }), response, actionDependencies({
    calls,
    connector,
    environment,
    runMongoTransaction: async work => {
      calls.push('transaction.begin')
      try {
        return await work({ id: 'rollback-session' })
      } catch (error) {
        restoreEnvironment(environment, snapshot)
        calls.push('transaction.rollback')
        throw error
      }
    },
    audit: async () => { throw new Error('audit datastore unavailable') },
  }))

  assert.equal(response.statusCode, 500)
  assert.deepEqual(environmentSnapshot(environment), snapshot)
  assert.ok(calls.includes('transaction.rollback'))
  assert.equal(response.body.code, 'CONNECTOR_REQUEST_FAILED')
  assert.doesNotMatch(JSON.stringify(response.body), /audit datastore unavailable/)
})

test('a missing transaction capability fails closed with a stable public code', async () => {
  const calls = []
  const environment = environmentRecord(calls)
  const response = mockResponse()
  const snapshot = environmentSnapshot(environment)

  await runHandler(actionRequest('select-device', { deviceId: newDeviceId }), response, actionDependencies({
    calls,
    connector: connectorRecord(),
    environment,
    runMongoTransaction: async () => {
      throw Object.assign(new Error('MongoDB transactions are required.'), { code: 'MONGO_TRANSACTIONS_REQUIRED', statusCode: 503 })
    },
  }))

  assert.equal(response.statusCode, 503)
  assert.equal(response.body.code, 'MONGO_TRANSACTIONS_REQUIRED')
  assert.deepEqual(environmentSnapshot(environment), snapshot)
  assert.equal(calls.includes('environment.save'), false)
})

test('an enabled connector cannot switch devices and never contacts the catalog', async () => {
  const calls = []
  const response = mockResponse()
  await runHandler(actionRequest('select-device', { deviceId: newDeviceId }), response, actionDependencies({
    calls,
    connector: connectorRecord({ enabled: true }),
    environment: environmentRecord(calls),
    getThingsBoardDevice: async () => {
      calls.push('catalog.lookup')
      return { id: newDeviceId }
    },
  }))

  assert.equal(response.statusCode, 409)
  assert.equal(response.body.code, 'CONNECTOR_DEVICE_SWITCH_REQUIRES_DISABLE')
  assert.equal(calls.includes('catalog.lookup'), false)
})

test('device selection rechecks connector lifecycle inside the transaction', async () => {
  const calls = []
  const response = mockResponse()
  const environment = environmentRecord(calls)
  const initiallyDisabled = connectorRecord()
  const concurrentlyEnabled = connectorRecord({ enabled: true })

  await runHandler(actionRequest('select-device', { deviceId: newDeviceId }), response, actionDependencies({
    calls,
    connector: initiallyDisabled,
    environment,
    ownedConnector: async (_connectorId, _principal, _projectId, session = null) => session ? concurrentlyEnabled : initiallyDisabled,
    audit: async () => { calls.push('audit.save') },
  }))

  assert.equal(response.statusCode, 409)
  assert.equal(response.body.code, 'CONNECTOR_DEVICE_SWITCH_REQUIRES_DISABLE')
  assert.equal(environment.config.deviceId, oldDeviceId)
  assert.equal(calls.includes('environment.save'), false)
  assert.equal(calls.includes('audit.save'), false)
})

test('browse and discovery actions pass through the authenticated handler without exposing JWT', async () => {
  for (const [action, extra, expected] of [
    ['browse-devices', { textSearch: 'Mixer' }, 'devices'],
    ['discover-device-telemetry', { deviceId: newDeviceId }, 'keys'],
  ]) {
    const calls = []
    const response = mockResponse()
    await runHandler(actionRequest(action, extra), response, actionDependencies({
      calls,
      connector: connectorRecord(),
      environment: environmentRecord(calls),
      listThingsBoardDevices: async ({ jwt, textSearch }) => {
        assert.equal(jwt, 'private-jwt')
        assert.equal(textSearch, 'Mixer')
        return { devices: [{ id: newDeviceId, name: 'Mixer' }], page: 0, pageSize: 20, totalElements: 1, totalPages: 1, hasNext: false }
      },
      discoverThingsBoardTelemetry: async ({ jwt, deviceId }) => {
        assert.equal(jwt, 'private-jwt')
        assert.equal(deviceId, newDeviceId)
        return { deviceId, keys: [{ key: 'temperature', dataType: 'number', sample: 21.5 }], truncated: false }
      },
    }))
    assert.equal(response.statusCode, 200)
    assert.ok(Array.isArray(response.body[expected]))
    assert.doesNotMatch(JSON.stringify(response.body), /private-jwt/)
  }
})

function actionRequest(action, extra = {}) {
  return {
    method: 'POST',
    query: {},
    body: { projectId: project.id, connectorId: 'connector-1', environmentRef: 'staging', action, ...extra },
  }
}

function runHandler(req, res, dependencies) {
  return createConnectorHandler(dependencies)(req, res)
}

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

function outerDependencies() {
  return {
    requirePrincipal: async () => principal,
    connectMongo: async () => {},
    findProject: async () => project,
    requireProjectPermission: async () => ({ project, effectiveRole: principal.role }),
    requireCsrf: () => true,
    enforceRateLimit: async () => true,
  }
}

function actionDependencies({ calls, connector, environment, ...overrides }) {
  return {
    ...outerDependencies(),
    enforceRateLimit: async (_req, _res, scope) => {
      calls.push(`rate.${scope}`)
      return true
    },
    ownedConnector: async (_connectorId, _principal, _projectId, session = null) => {
      calls.push(session ? 'connector.load.transaction' : 'connector.load')
      return connector
    },
    findEnvironment: async (_connectorId, _environmentRef, session = null) => {
      calls.push(session ? 'environment.load.transaction' : 'environment.load')
      return environment
    },
    withThingsBoardAccessToken: async (_context, work) => work('private-jwt'),
    listThingsBoardDevices: async () => ({ devices: [], page: 0, pageSize: 20, totalElements: 0, totalPages: 0, hasNext: false }),
    discoverThingsBoardTelemetry: async ({ deviceId }) => ({ deviceId, keys: [], truncated: false }),
    getThingsBoardDevice: async ({ jwt, deviceId }) => {
      assert.equal(jwt, 'private-jwt')
      return { id: deviceId, name: 'Mixer', label: '', type: 'mixer', createdTime: null }
    },
    runMongoTransaction: async work => work({ id: 'default-session' }),
    audit: async () => {},
    now: () => new Date('2026-09-15T00:00:00.000Z'),
    ...overrides,
  }
}

function connectorRecord({ enabled = false } = {}) {
  return {
    id: 'connector-1',
    _id: 'connector-1',
    projectId: project.id,
    name: 'Plant ThingsBoard',
    type: 'thingsboard',
    enabled,
    toObject() { return { _id: this._id, projectId: this.projectId, name: this.name, type: this.type, enabled: this.enabled } },
  }
}

function environmentRecord(calls) {
  return {
    id: 'environment-1',
    _id: 'environment-1',
    environmentRef: 'staging',
    config: { serverUrl: 'https://tb.example.test', deviceId: oldDeviceId, rpcMode: 'two-way', commandTimeoutMs: 5000 },
    health: { state: 'online', message: 'Connected' },
    commandHealth: { state: 'acknowledged', message: 'Ready' },
    updatedBy: 'owner-1',
    savedWith: null,
    async save(options) { this.savedWith = options; calls.push('environment.save'); return this },
    toObject() {
      return { _id: this._id, environmentRef: this.environmentRef, config: { ...this.config }, health: { ...this.health }, commandHealth: { ...this.commandHealth }, updatedBy: this.updatedBy }
    },
  }
}

function environmentSnapshot(environment) {
  return {
    config: structuredClone(environment.config),
    health: structuredClone(environment.health),
    commandHealth: structuredClone(environment.commandHealth),
    updatedBy: environment.updatedBy,
  }
}

function restoreEnvironment(environment, snapshot) {
  environment.config = structuredClone(snapshot.config)
  environment.health = structuredClone(snapshot.health)
  environment.commandHealth = structuredClone(snapshot.commandHealth)
  environment.updatedBy = snapshot.updatedBy
}
