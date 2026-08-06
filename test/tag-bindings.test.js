import test from 'node:test'
import assert from 'node:assert/strict'
import { componentTagReferences, tagUsageCounts } from '../shared/tag-bindings.js'

test('feedback tags count as component bindings and cannot be mistaken for unused tags', () => {
  const components = [
    {
      id: 'operation-mode',
      type: 'operation-shifter',
      binding: { tagId: 'mode.command' },
      properties: { feedbackTagId: 'mode.actual' },
    },
    {
      id: 'valve-button',
      type: 'control-button',
      binding: { tagId: 'valve.command' },
      properties: { feedbackTagId: 'valve.actual' },
    },
  ]
  const usage = tagUsageCounts(components)
  assert.equal(usage.get('mode.command'), 1)
  assert.equal(usage.get('mode.actual'), 1)
  assert.equal(usage.get('valve.actual'), 1)
})

test('one component counts a shared command and feedback tag only once', () => {
  const component = {
    type: 'operation-shifter',
    binding: { tagId: 'mode' },
    properties: { feedbackTagId: 'mode' },
  }
  assert.deepEqual(componentTagReferences(component), ['mode'])
  assert.equal(tagUsageCounts([component]).get('mode'), 1)
})

test('Chart tag arrays remain unique component references', () => {
  const chart = { type: 'chart', binding: { tagIds: ['level', 'level', 'flow'] }, properties: {} }
  assert.deepEqual(componentTagReferences(chart), ['level', 'flow'])
})
