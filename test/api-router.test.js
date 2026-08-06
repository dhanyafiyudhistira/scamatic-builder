import test from 'node:test'
import assert from 'node:assert/strict'
import apiRouter from '../api/[route].js'

test('consolidated Vercel API router rejects unknown routes without changing public endpoint names', async () => {
  const response = mockResponse()
  await apiRouter({ query: { route: 'missing' } }, response)
  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.body, { error: 'API route not found.', code: 'API_ROUTE_NOT_FOUND' })
})

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this },
    json(value) { this.body = value; return this },
  }
}
