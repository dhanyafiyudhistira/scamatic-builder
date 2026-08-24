import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeHardPassword } from '../shared/hard-password.js'

test('hard password encoder reproduces the requested numeric and capital-delimited word pattern', () => {
  assert.equal(encodeHardPassword('040801DanteHowardAutomation'), '040903IeqvfNtadteKdbvsfxlqo')
})

test('numeric offsets skip zero and continue naturally beyond one digit', () => {
  assert.equal(encodeHardPassword('9099'), '901011')
})

test('letter shifts wrap through the alphabet and preserve letter case', () => {
  assert.equal(encodeHardPassword('xyzXyz'), 'aaaAaa')
})

test('hard password encoder rejects spaces and symbols', () => {
  assert.throws(() => encodeHardPassword('Dante Howard'), /letters and numbers only/)
  assert.throws(() => encodeHardPassword('Dante!'), /letters and numbers only/)
})
