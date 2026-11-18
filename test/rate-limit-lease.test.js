import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeRateLimitLeaseGrant, rateLimitLeaseRefillThreshold, reservedRateLimitGrant } from '../api/_lib/security.js'

test('rate-limit reservations grant a full lease below the ceiling', () => {
  assert.deepEqual(reservedRateLimitGrant({ recordCount: 24, reservationSize: 12, limit: 120 }), { granted: 12 })
})

test('rate-limit reservations grant only remaining permits at the boundary', () => {
  assert.deepEqual(reservedRateLimitGrant({ recordCount: 128, reservationSize: 12, limit: 120 }), { granted: 4 })
})

test('rate-limit reservations never grant above an exhausted ceiling', () => {
  assert.deepEqual(reservedRateLimitGrant({ recordCount: 132, reservationSize: 12, limit: 120 }), { granted: 0 })
})

test('rate-limit lease starts refilling at a bounded low-water mark', () => {
  assert.equal(rateLimitLeaseRefillThreshold(12), 3)
  assert.equal(rateLimitLeaseRefillThreshold(20), 5)
  assert.equal(rateLimitLeaseRefillThreshold(1), 1)
})

test('prefetched permits append to the current lease without exceeding the distributed grant', () => {
  assert.deepEqual(
    mergeRateLimitLeaseGrant(
      { allowed: true, remaining: 3, reportedRemaining: 99 },
      { recordCount: 24, reservationSize: 12, limit: 120 },
    ),
    { allowed: true, exhausted: false, remaining: 15, reportedRemaining: 111 },
  )
})

test('an exhausted prefetch preserves already reserved local permits and blocks another refill', () => {
  assert.deepEqual(
    mergeRateLimitLeaseGrant(
      { allowed: true, remaining: 2, reportedRemaining: 2 },
      { recordCount: 132, reservationSize: 12, limit: 120 },
    ),
    { allowed: true, exhausted: true, remaining: 2, reportedRemaining: 2 },
  )
})
