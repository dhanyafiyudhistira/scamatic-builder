import test from 'node:test'
import assert from 'node:assert/strict'
import { createIsaacSessionAuthorizer } from '../server/connectors/isaac-session-authorizer.js'

const TOKEN = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH'

test('Isaac internal authorizer delegates one-time ticket authorization', async () => {
  const calls = []
  const handler = createIsaacSessionAuthorizer({
    internalToken: TOKEN,
    authorize: async ticket => {
      calls.push(ticket)
      return { runtimeSessionId: 'runtime-1', projectId: 'project-1' }
    },
  })
  const response = fakeResponse()
  await handler(fakeRequest({ action: 'authorize', ticket: 'ticket-1' }), response)

  assert.deepEqual(calls, ['ticket-1'])
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.equal(response.body.session.runtimeSessionId, 'runtime-1')
})

test('Isaac internal authorizer revalidates only the requested runtime session', async () => {
  const calls = []
  const handler = createIsaacSessionAuthorizer({
    internalToken: TOKEN,
    revalidate: async runtimeSessionId => {
      calls.push(runtimeSessionId)
      return { runtimeSessionId, projectId: 'project-1' }
    },
  })
  const response = fakeResponse()
  await handler(fakeRequest({ action: 'revalidate', runtimeSessionId: 'runtime-2' }), response)

  assert.deepEqual(calls, ['runtime-2'])
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.session.runtimeSessionId, 'runtime-2')
})

test('Isaac internal authorizer hides the route from invalid tokens', async () => {
  let called = false
  const handler = createIsaacSessionAuthorizer({
    internalToken: TOKEN,
    authorize: async () => { called = true },
  })
  const response = fakeResponse()
  await handler(fakeRequest({ action: 'authorize', ticket: 'ticket-1' }, { token: 'wrong' }), response)

  assert.equal(called, false)
  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.body, { ok: false, code: 'NOT_FOUND' })
})

test('Isaac internal authorizer fails closed for unsupported actions and rejected sessions', async () => {
  const handler = createIsaacSessionAuthorizer({ internalToken: TOKEN })
  const response = fakeResponse()
  await handler(fakeRequest({ action: 'unknown' }), response)

  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.body, { ok: false, code: 'ISAAC_SESSION_INVALID' })
})

test('Isaac internal authorizer rejects a valid token arriving from a non-loopback socket', async () => {
  let called = false
  const handler = createIsaacSessionAuthorizer({
    internalToken: TOKEN,
    authorize: async () => { called = true },
  })
  const response = fakeResponse()
  await handler(fakeRequest({ action: 'authorize', ticket: 'ticket-1' }, { remoteAddress: '192.0.2.10' }), response)

  assert.equal(called, false)
  assert.equal(response.statusCode, 404)
})

function fakeRequest(body, { token = TOKEN, remoteAddress = '127.0.0.1' } = {}) {
  return {
    method: 'POST',
    headers: { 'x-isaac-internal-token': token },
    socket: { remoteAddress },
    body,
  }
}

function fakeResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(value) {
      this.body = value
      return this
    },
  }
}
