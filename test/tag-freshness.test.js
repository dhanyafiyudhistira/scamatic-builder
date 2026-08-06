import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTagFreshness, shouldObserveFreshnessInterval, tagFreshnessThresholds } from '../shared/tag-freshness.js'

test('periodic tag freshness adapts to healthy publish jitter within a bounded cap', () => {
  const tag = { freshnessMode: 'periodic', adaptiveFreshness: true, staleAfterMs: 10_000 }
  assert.deepEqual(tagFreshnessThresholds(tag, [4_000, 5_000]), {
    mode: 'periodic',
    adaptive: true,
    sampleCount: 2,
    staleAfterMs: 10_000,
    disconnectAfterMs: 30_000,
  })
  assert.deepEqual(tagFreshnessThresholds(tag, [4_000, 5_000, 5_500, 4_500]), {
    mode: 'periodic',
    adaptive: true,
    sampleCount: 4,
    staleAfterMs: 16_500,
    disconnectAfterMs: 49_500,
  })
  assert.equal(tagFreshnessThresholds(tag, [20_000, 20_000, 20_000]).staleAfterMs, 30_000)
})

test('event-driven tags stay quiet until connector state or a new sample changes them', () => {
  assert.deepEqual(tagFreshnessThresholds({ freshnessMode: 'event-driven', staleAfterMs: 10_000 }, [5_000, 6_000, 7_000]), {
    mode: 'event-driven',
    adaptive: false,
    sampleCount: 0,
    staleAfterMs: null,
    disconnectAfterMs: null,
  })
})

test('freshness learning ignores disconnected outages and normalizes legacy tags safely', () => {
  const tag = normalizeTagFreshness({ id: 'level' })
  assert.equal(tag.freshnessMode, 'periodic')
  assert.equal(tag.adaptiveFreshness, true)
  assert.equal(tag.staleAfterMs, 10_000)
  assert.equal(shouldObserveFreshnessInterval(tag, 5_000, 'good'), true)
  assert.equal(shouldObserveFreshnessInterval(tag, 5_000, 'disconnected'), false)
  assert.equal(shouldObserveFreshnessInterval(tag, 31_000, 'good'), false)
})
