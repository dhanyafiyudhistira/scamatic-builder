import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  loginThingsBoardAccount,
  mergeThingsBoardSecret,
  refreshThingsBoardTokenPair,
  thingsBoardAuthenticationMetadata,
  thingsBoardJwtExpiresAt,
  withThingsBoardAccessToken,
} from '../api/_lib/thingsboard-auth.js'

test('ThingsBoard JWT expiry is decoded without trusting or exposing the token', () => {
  const expiresAt = 1_800_000_000
  const token = jwt({ sub: 'tenant', exp: expiresAt })
  assert.equal(thingsBoardJwtExpiresAt(token)?.toISOString(), new Date(expiresAt * 1000).toISOString())
  assert.equal(thingsBoardJwtExpiresAt('not-a-jwt'), null)
})

test('authentication metadata distinguishes manual JWT and automatic refresh', () => {
  const now = new Date('2026-08-06T00:00:00.000Z')
  const access = jwt({ exp: Math.floor(now.getTime() / 1000) + 3_600 })
  const refresh = jwt({ exp: Math.floor(now.getTime() / 1000) + 86_400 })
  assert.equal(thingsBoardAuthenticationMetadata({ jwt: access }, { now }).mode, 'manual-jwt')
  const automatic = thingsBoardAuthenticationMetadata({ jwt: access, refreshToken: refresh }, { now })
  assert.equal(automatic.mode, 'refresh-token')
  assert.equal(automatic.state, 'healthy')
  assert.equal(automatic.message, 'JWT auto-refresh is active.')
  assert.equal(JSON.stringify(automatic).includes(access), false)
  assert.equal(JSON.stringify(automatic).includes(refresh), false)
})

test('ThingsBoard account login and token refresh exchange validated token pairs', async t => {
  const access = jwt({ exp: 1_900_000_000, marker: 'access' })
  const refresh = jwt({ exp: 1_900_086_400, marker: 'refresh' })
  const renewed = jwt({ exp: 1_900_003_600, marker: 'renewed' })
  const nextRefresh = jwt({ exp: 1_900_090_000, marker: 'next-refresh' })
  const requests = []
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req)
    requests.push({ url: req.url, body })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/api/auth/login') return res.end(JSON.stringify({ token: access, refreshToken: refresh }))
    if (req.url === '/api/auth/token') return res.end(JSON.stringify({ token: renewed, refreshToken: nextRefresh }))
    res.writeHead(404); res.end()
  })
  await listen(server)
  t.after(() => close(server))
  const serverUrl = `http://127.0.0.1:${server.address().port}`
  const options = { serverUrl, validateTarget: async value => value }

  assert.deepEqual(await loginThingsBoardAccount({ ...options, username: 'operator@example.com', password: 'secret' }), { token: access, refreshToken: refresh })
  assert.deepEqual(await refreshThingsBoardTokenPair({ ...options, refreshToken: refresh }), { token: renewed, refreshToken: nextRefresh })
  assert.deepEqual(requests, [
    { url: '/api/auth/login', body: { username: 'operator@example.com', password: 'secret' } },
    { url: '/api/auth/token', body: { refreshToken: refresh } },
  ])
})

test('ThingsBoard rejects incomplete authentication responses', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ token: 'access-without-refresh-token' }))
  })
  await listen(server)
  t.after(() => close(server))
  await assert.rejects(
    loginThingsBoardAccount({ serverUrl: `http://127.0.0.1:${server.address().port}`, username: 'operator@example.com', password: 'secret', validateTarget: async value => value }),
    error => error.code === 'THINGSBOARD_LOGIN_FAILED',
  )
})

test('manual JWT rotation cannot retain a refresh token from an older token pair', () => {
  const current = { jwt: 'old-access-token', refreshToken: 'old-refresh-token', deviceToken: 'device-token' }
  assert.deepEqual(mergeThingsBoardSecret(current, { jwt: 'new-manual-access-token' }), {
    jwt: 'new-manual-access-token',
    deviceToken: 'device-token',
  })
  assert.deepEqual(mergeThingsBoardSecret(current, { jwt: 'new-access-token', refreshToken: 'new-refresh-token' }), {
    jwt: 'new-access-token',
    refreshToken: 'new-refresh-token',
    deviceToken: 'device-token',
  })
  assert.deepEqual(mergeThingsBoardSecret(current, { deviceToken: 'new-device-token' }), {
    jwt: 'old-access-token',
    refreshToken: 'old-refresh-token',
    deviceToken: 'new-device-token',
  })
  assert.throws(
    () => mergeThingsBoardSecret(current, { refreshToken: 'orphan-refresh-token' }),
    /must be rotated together/,
  )
})

test('an unauthorized ThingsBoard operation refreshes once and retries with the replacement JWT', async () => {
  const tokenCalls = []
  const operationCalls = []
  const tokenProvider = async context => {
    tokenCalls.push(context)
    return { jwt: tokenCalls.length === 1 ? 'rejected-access-token' : 'replacement-access-token' }
  }
  const result = await withThingsBoardAccessToken(
    { connectorId: 'connector-a', environmentRef: 'staging' },
    async jwtValue => {
      operationCalls.push(jwtValue)
      return operationCalls.length === 1 ? { status: 401 } : { status: 200, ok: true }
    },
    { tokenProvider },
  )

  assert.deepEqual(operationCalls, ['rejected-access-token', 'replacement-access-token'])
  assert.equal(tokenCalls.length, 2)
  assert.deepEqual(tokenCalls[1], {
    connectorId: 'connector-a',
    environmentRef: 'staging',
    forceRefresh: true,
    rejectedToken: 'rejected-access-token',
  })
  assert.deepEqual(result, { status: 200, ok: true })
})

test('non-authentication failures are not retried through the token provider', async () => {
  let tokenCalls = 0
  const failure = Object.assign(new Error('upstream unavailable'), { status: 503 })
  await assert.rejects(
    withThingsBoardAccessToken(
      { connectorId: 'connector-a' },
      async () => { throw failure },
      { tokenProvider: async () => { tokenCalls += 1; return { jwt: 'access-token' } } },
    ),
    error => error === failure,
  )
  assert.equal(tokenCalls, 1)
})

function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature-for-tests`
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}

function close(server) {
  return new Promise(resolve => server.close(resolve))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
    req.on('error', reject)
  })
}
