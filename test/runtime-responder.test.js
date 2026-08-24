import test from 'node:test'
import assert from 'node:assert/strict'
import { nextRuntimeResponderIdentity, validRuntimeResponderGeneration, validRuntimeResponderId } from '../shared/runtime-responder.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

test('runtime responder identity survives reload and advances its generation', () => {
  const storage = memoryStorage()
  const first = nextRuntimeResponderIdentity({ storage, randomUUID: () => 'runtime-tab-identity-0001' })
  const reloaded = nextRuntimeResponderIdentity({ storage, randomUUID: () => 'must-not-be-used-0002' })
  assert.deepEqual(first, { id: 'runtime-tab-identity-0001', generation: 1 })
  assert.deepEqual(reloaded, { id: 'runtime-tab-identity-0001', generation: 2 })
})

test('runtime responder identity validation rejects unsafe IDs and generations', () => {
  assert.equal(validRuntimeResponderId('runtime-tab-identity-0001'), true)
  assert.equal(validRuntimeResponderId('short'), false)
  assert.equal(validRuntimeResponderGeneration(1), true)
  assert.equal(validRuntimeResponderGeneration(0), false)
  assert.equal(validRuntimeResponderGeneration(1.5), false)
})
