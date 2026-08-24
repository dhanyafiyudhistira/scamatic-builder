import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdaptiveRecoveryScheduler } from '../server/connectors/adaptive-recovery-scheduler.js'

test('adaptive recovery polls quickly while work remains and backs off after an empty pass', async () => {
  const clock = fakeClock()
  const results = [4, 0]
  let calls = 0
  const scheduler = createAdaptiveRecoveryScheduler({
    recover: async () => { calls += 1; return results.shift() },
    activeDelayMs: 1_000,
    idleDelayMs: 30_000,
    ...clock.options,
  })

  assert.equal(await scheduler.start(), 4)
  assert.deepEqual(clock.delays(), [1_000])
  await clock.runNext()
  assert.equal(calls, 2)
  assert.deepEqual(clock.delays(), [30_000])

  await scheduler.stop()
})

test('adaptive recovery retries errors quickly and an audit failure wakes an idle scheduler immediately', async () => {
  const clock = fakeClock()
  const failure = Object.assign(new Error('database unavailable'), { code: 'DB_DOWN' })
  const results = [failure, 0, 0]
  const errors = []
  const scheduler = createAdaptiveRecoveryScheduler({
    recover: async () => {
      const result = results.shift()
      if (result instanceof Error) throw result
      return result
    },
    activeDelayMs: 1_000,
    idleDelayMs: 30_000,
    onError: error => errors.push(error.code),
    ...clock.options,
  })

  assert.equal(await scheduler.start(), 0)
  assert.deepEqual(errors, ['DB_DOWN'])
  assert.deepEqual(clock.delays(), [1_000])
  await clock.runNext()
  assert.deepEqual(clock.delays(), [30_000])

  assert.equal(scheduler.request(), true)
  assert.deepEqual(clock.delays(), [0])
  await clock.runNext()
  assert.deepEqual(clock.delays(), [30_000])

  await scheduler.stop()
})

test('stopping adaptive recovery cancels its timer and prevents later wakeups', async () => {
  const clock = fakeClock()
  let calls = 0
  const scheduler = createAdaptiveRecoveryScheduler({
    recover: async () => { calls += 1; return 0 },
    ...clock.options,
  })

  await scheduler.start()
  assert.equal(clock.size(), 1)
  await scheduler.stop()
  assert.equal(clock.size(), 0)
  assert.equal(scheduler.request(), false)
  assert.equal(calls, 1)
})

test('wake requests during recovery coalesce into one non-overlapping follow-up pass', async () => {
  const clock = fakeClock()
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let calls = 0
  let active = 0
  let maxActive = 0
  const scheduler = createAdaptiveRecoveryScheduler({
    recover: async () => {
      calls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      if (calls === 1) await firstGate
      active -= 1
      return 0
    },
    ...clock.options,
  })

  const startup = scheduler.start()
  assert.equal(scheduler.request(), true)
  assert.equal(scheduler.request(), true)
  releaseFirst()
  await startup
  assert.deepEqual(clock.delays(), [0])
  await clock.runNext()

  assert.equal(calls, 2)
  assert.equal(maxActive, 1)
  assert.deepEqual(clock.delays(), [30_000])
  await scheduler.stop()
})

function fakeClock() {
  let now = 0
  let nextId = 1
  const tasks = new Map()
  return {
    options: {
      now: () => now,
      setTimer(callback, delay) {
        const handle = { id: nextId++, unref() {} }
        tasks.set(handle.id, { callback, delay, dueAt: now + delay })
        return handle
      },
      clearTimer(handle) { tasks.delete(handle?.id) },
    },
    delays: () => [...tasks.values()].map(task => task.delay),
    size: () => tasks.size,
    async runNext() {
      const [id, task] = [...tasks.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0] || []
      if (!task) return
      tasks.delete(id)
      now = task.dueAt
      task.callback()
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}
