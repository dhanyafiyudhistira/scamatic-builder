import test from 'node:test'
import assert from 'node:assert/strict'
import { legacySettingsReadEnabled, normalizeLegacyMode } from '../api/_handlers/settings.js'

test('legacy settings compatibility is opt-in', () => {
  const previous = process.env.LEGACY_DIRECT_THINGSBOARD_ENABLED
  try {
    delete process.env.LEGACY_DIRECT_THINGSBOARD_ENABLED
    assert.equal(legacySettingsReadEnabled(), false)
    process.env.LEGACY_DIRECT_THINGSBOARD_ENABLED = 'true'
    assert.equal(legacySettingsReadEnabled(), true)
  } finally {
    if (previous === undefined) delete process.env.LEGACY_DIRECT_THINGSBOARD_ENABLED
    else process.env.LEGACY_DIRECT_THINGSBOARD_ENABLED = previous
  }
})

test('legacy settings mode accepts bounded identifiers and rejects query-shaped input', () => {
  assert.equal(normalizeLegacyMode('deck-user'), 'deck-user')
  assert.equal(normalizeLegacyMode(['legacy-scada', 'ignored']), 'legacy-scada')
  assert.equal(normalizeLegacyMode({ $ne: '' }), 'global')
  assert.equal(normalizeLegacyMode('../deck-user'), 'global')
  assert.equal(normalizeLegacyMode('x'.repeat(65)), 'global')
})
