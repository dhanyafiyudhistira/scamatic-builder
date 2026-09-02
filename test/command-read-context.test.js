import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCommandAdmissionReads, loadCommandStatusReads, loadLiveCommandReads } from '../api/_lib/command-read-context.js'

test('command admission starts independent MongoDB reads without serial waits', async () => {
  const started = []
  const pending = new Map()
  const read = (name, value) => () => {
    started.push(name)
    return new Promise(resolve => pending.set(name, () => resolve(value)))
  }
  const resultPromise = loadCommandAdmissionReads({
    loadProject: read('project', { id: 'project-1' }),
    loadRuntimeSession: read('runtime-session', { id: 'session-1' }),
    loadDuplicate: read('duplicate', null),
  })

  assert.deepEqual(started, ['project', 'runtime-session', 'duplicate'])
  for (const release of pending.values()) release()
  assert.deepEqual(await resultPromise, {
    project: { id: 'project-1' },
    runtimeSession: { id: 'session-1' },
    duplicate: null,
  })
})

test('command status overlaps project authorization context and runtime-session reads', async () => {
  const started = []
  const pending = new Map()
  const read = (name, value) => () => {
    started.push(name)
    return new Promise(resolve => pending.set(name, () => resolve(value)))
  }
  const resultPromise = loadCommandStatusReads({
    loadProject: read('project', { id: 'project-1' }),
    loadRuntimeSession: read('runtime-session', { id: 'session-1' }),
  })

  assert.deepEqual(started, ['project', 'runtime-session'])
  for (const release of pending.values()) release()
  assert.deepEqual(await resultPromise, {
    project: { id: 'project-1' },
    runtimeSession: { id: 'session-1' },
  })
})

test('live command reads overlap cooldown, snapshot, connector, and environment lookups', async () => {
  const started = []
  const read = (name, value) => async () => { started.push(name); return value }
  const result = await loadLiveCommandReads({
    loadPendingCommand: read('pending', null),
    loadSnapshot: read('snapshot', { value: true }),
    loadConnector: read('connector', { id: 'connector-1' }),
    loadEnvironment: read('environment', { environmentRef: 'staging' }),
    connectorLookupsEnabled: true,
  })

  assert.deepEqual(started, ['connector', 'environment', 'pending', 'snapshot'])
  assert.deepEqual(result, {
    recent: null,
    snapshot: { value: true },
    connector: { id: 'connector-1' },
    environment: { environmentRef: 'staging' },
  })
})

test('disabled live commands skip connector lookups', async () => {
  let connectorReads = 0
  const result = await loadLiveCommandReads({
    loadPendingCommand: async () => null,
    loadSnapshot: async () => ({ value: false }),
    loadConnector: async () => { connectorReads += 1 },
    loadEnvironment: async () => { connectorReads += 1 },
    connectorLookupsEnabled: false,
  })

  assert.equal(connectorReads, 0)
  assert.deepEqual(result, { recent: null, snapshot: { value: false }, connector: null, environment: null })
})
