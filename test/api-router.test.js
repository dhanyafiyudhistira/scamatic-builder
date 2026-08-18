import test from 'node:test'
import assert from 'node:assert/strict'
import apiRouter from '../api/[route].js'

test('consolidated Vercel API router rejects unknown routes without changing public endpoint names', async () => {
  const response = mockResponse()
  await apiRouter({ query: { route: 'missing' } }, response)
  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.body, { error: 'API route not found.', code: 'API_ROUTE_NOT_FOUND' })
})

test('consolidated API router exposes signup with validation before database work', async () => {
  const response = mockResponse()
  await apiRouter({
    method: 'POST',
    query: { route: 'signup' },
    headers: { origin: 'http://localhost:5173' },
    body: { email: 'invalid', password: 'long-enough-password', confirmPassword: 'long-enough-password' },
  }, response)
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.body, { error: 'Enter a valid email address.', code: 'SIGNUP_INVALID' })
})

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    status(value) { this.statusCode = value; return this },
    json(value) { this.body = value; return this },
  }
}
