import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrailingTaskRunner } from '../server/connectors/trailing-task-runner.js'

test('requests during an active task coalesce into one non-overlapping trailing pass', async () => {
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let calls = 0
  let active = 0
  let maxActive = 0
  const runner = createTrailingTaskRunner({
    task: async () => {
      calls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      if (calls === 1) await firstGate
      active -= 1
      return calls
    },
  })

  const first = runner.request()
  const second = runner.request()
  const third = runner.request()
  assert.equal(first, second)
  assert.equal(second, third)
  releaseFirst()

  assert.equal(await first, 2)
  assert.equal(calls, 2)
  assert.equal(maxActive, 1)
  await runner.stop()
})

test('a failed task can be requested again after the current drain settles', async () => {
  let calls = 0
  const runner = createTrailingTaskRunner({
    task: async () => {
      calls += 1
      if (calls === 1) throw new Error('temporary failure')
      return 'recovered'
    },
  })

  await assert.rejects(runner.request(), /temporary failure/)
  assert.equal(await runner.request(), 'recovered')
  await runner.stop()
})

test('a trailing request retries after an active pass fails', async () => {
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let calls = 0
  const runner = createTrailingTaskRunner({
    task: async () => {
      calls += 1
      if (calls === 1) {
        await firstGate
        throw new Error('stale reload failed')
      }
      return 'latest state loaded'
    },
  })

  const first = runner.request()
  assert.equal(runner.request(), first)
  releaseFirst()

  assert.equal(await first, 'latest state loaded')
  assert.equal(calls, 2)
  await runner.stop()
})

test('stop waits for the active task and cancels a queued trailing pass', async () => {
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let calls = 0
  const runner = createTrailingTaskRunner({
    task: async () => {
      calls += 1
      await firstGate
    },
  })

  void runner.request()
  void runner.request()
  const stopping = runner.stop()
  releaseFirst()
  await stopping

  assert.equal(calls, 1)
  assert.equal(await runner.request(), false)
})
