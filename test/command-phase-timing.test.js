import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMAND_PHASE_TIMING_FIELDS, createCommandPhaseTimer } from '../shared/command-phase-timing.js'

test('command phase timer measures operations without delaying or changing their result', async () => {
  let clock = 100
  const timer = createCommandPhaseTimer({ now: () => clock })

  const result = await timer.measure('admissionReadsMs', async () => {
    clock += 17.4
    return { admitted: true }
  })
  clock += 2.2

  assert.deepEqual(result, { admitted: true })
  assert.deepEqual(timer.snapshot(), {
    admissionReadsMs: 17,
    admissionTotalMs: 17,
    serverResponseReadyMs: 20,
    unattributedMs: 3,
  })
})

test('command phase timer preserves thrown errors and records the failed operation duration', async () => {
  let clock = 0
  const timer = createCommandPhaseTimer({ now: () => clock })

  await assert.rejects(
    timer.measure('terminalPersistMs', async () => {
      clock = 9
      throw new Error('write failed')
    }),
    /write failed/,
  )
  assert.equal(timer.snapshot().terminalPersistMs, 9)
})

test('command phase timing uses a bounded allowlist and ignores a backward clock', async () => {
  let clock = 10
  const timer = createCommandPhaseTimer({ now: () => clock })
  await assert.rejects(() => timer.measure('secretQueryMs', async () => true), /Unsupported command phase/)

  await timer.measure('commandCreateMs', async () => { clock = 5 })
  const timing = timer.snapshot()
  assert.equal('commandCreateMs' in timing, false)
  assert.equal('serverResponseReadyMs' in timing, false)
  assert.equal(COMMAND_PHASE_TIMING_FIELDS.includes('secretQueryMs'), false)
})

test('disabled command phase timing executes operations directly without reading a clock', async () => {
  let clockReads = 0
  const timer = createCommandPhaseTimer({ enabled: false, now: () => { clockReads += 1; return 10 } })
  const marker = { ok: true }

  assert.equal(await timer.measure('admissionReadsMs', () => marker), marker)
  assert.equal(timer.snapshot(), null)
  assert.equal(clockReads, 0)
})
