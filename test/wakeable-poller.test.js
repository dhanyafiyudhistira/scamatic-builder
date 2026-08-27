import test from 'node:test'
import assert from 'node:assert/strict'
import { createWakeablePoller } from '../server/connectors/wakeable-poller.js'

test('wakeable poller preserves periodic fallback and runs an immediate wake', async () => {
  const clock = fakeInterval()
  let calls = 0
  const poller = createWakeablePoller({
    poll: async () => { calls += 1; return 0 },
    intervalMs: 250,
    ...clock.options,
  })

  await poller.start()
  assert.equal(calls, 1)
  assert.equal(clock.interval(), 250)
  assert.equal(poller.request(), true)
  await tick()
  assert.equal(calls, 2)
  await clock.fire()
  assert.equal(calls, 3)
  await poller.stop()
  assert.equal(clock.active(), false)
  assert.equal(poller.request(), false)
})

test('wake requests during a poll coalesce into one non-overlapping follow-up', async () => {
  const clock = fakeInterval()
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let calls = 0
  let active = 0
  let maxActive = 0
  const poller = createWakeablePoller({
    poll: async () => {
      calls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      if (calls === 1) await firstGate
      active -= 1
      return 0
    },
    ...clock.options,
  })

  const startup = poller.start()
  assert.equal(poller.request(), true)
  assert.equal(poller.request(), true)
  await clock.fire()
  releaseFirst()
  await startup
  await tick()
  assert.equal(calls, 2)
  assert.equal(maxActive, 1)
  await poller.stop()
})

test('a periodic fallback tick never overlaps or forces a trailing slow poll', async () => {
  const clock = fakeInterval()
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let calls = 0
  const poller = createWakeablePoller({
    poll: async () => {
      calls += 1
      if (calls === 1) await firstGate
      return 0
    },
    ...clock.options,
  })

  const startup = poller.start()
  await clock.fire()
  releaseFirst()
  await startup
  await tick()
  assert.equal(calls, 1)
  await poller.stop()
})

test('wakeable poller contains polling failures and remains available', async () => {
  const errors = []
  let calls = 0
  const poller = createWakeablePoller({
    poll: async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('database unavailable'), { code: 'DB_DOWN' })
      return 0
    },
    onError: error => errors.push(error.code),
  })

  assert.equal(await poller.start(), 0)
  assert.deepEqual(errors, ['DB_DOWN'])
  assert.equal(poller.request(), true)
  await tick()
  assert.equal(calls, 2)
  await poller.stop()
})

function fakeInterval() {
  let callback = null
  let delay = null
  let active = false
  return {
    options: {
      setIntervalImpl(next, milliseconds) {
        callback = next
        delay = milliseconds
        active = true
        return { unref() {} }
      },
      clearIntervalImpl() { active = false },
    },
    active: () => active,
    interval: () => delay,
    async fire() {
      callback?.()
      await tick()
    },
  }
}

function tick() {
  return new Promise(resolve => setImmediate(resolve))
}
