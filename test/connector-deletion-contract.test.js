import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('connector deletion preserves published snapshots without making them an impossible blocker', async () => {
  const [handler, manager] = await Promise.all([
    readFile(new URL('../api/_handlers/connectors.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/platform/ConnectorManager.jsx', import.meta.url), 'utf8'),
  ])

  const deletionHandler = handler.slice(handler.indexOf('async function deleteConnector'), handler.indexOf('async function testConnection'))
  assert.match(deletionHandler, /ProjectDraft\.exists/)
  assert.doesNotMatch(deletionHandler, /ProjectVersion/)
  assert.match(deletionHandler, /ConnectorSecret\.deleteMany/)
  assert.match(deletionHandler, /publishedHistoryPreserved: true/)
  assert.match(manager, /Published snapshots remain immutable/)
  assert.match(manager, /Connector and encrypted credentials deleted/)
})
