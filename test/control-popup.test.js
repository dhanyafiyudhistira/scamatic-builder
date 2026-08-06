import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assignControlToPopup,
  copySafeComponent,
  detachControlFromPopup,
  popupChildIdSet,
  removeComponentsAndCleanPopups,
  reorderPopupControl,
  rootRuntimeComponents,
} from '../shared/control-popup.js'

const components = [
  { id: 'button-a', type: 'control-button' },
  { id: 'button-b', type: 'control-button' },
  { id: 'slider-a', type: 'tuning-slider' },
  { id: 'lamp-a', type: 'indicator-lamp' },
  { id: 'popup-a', type: 'control-popup', children: ['button-a', 'slider-a'] },
  { id: 'popup-b', type: 'control-popup', children: [] },
]

test('Control Pop-up membership preserves a flat component graph and one owner', () => {
  const moved = assignControlToPopup(components, 'popup-b', 'button-a')
  assert.deepEqual(moved.find(item => item.id === 'popup-a').children, ['slider-a'])
  assert.deepEqual(moved.find(item => item.id === 'popup-b').children, ['button-a'])
  assert.deepEqual([...popupChildIdSet(moved)].sort(), ['button-a', 'slider-a'])
  assert.deepEqual(rootRuntimeComponents(moved).map(item => item.id), ['button-b', 'lamp-a', 'popup-a', 'popup-b'])
})

test('Control Pop-up rejects unsupported children and supports detach/reorder', () => {
  assert.equal(assignControlToPopup(components, 'popup-a', 'lamp-a'), components)
  const reordered = reorderPopupControl(components, 'popup-a', 'slider-a', -1)
  assert.deepEqual(reordered.find(item => item.id === 'popup-a').children, ['slider-a', 'button-a'])
  const detached = detachControlFromPopup(reordered, 'popup-a', 'slider-a')
  assert.deepEqual(detached.find(item => item.id === 'popup-a').children, ['button-a'])
})

test('Control Pop-up enforces the 16-control builder limit', () => {
  const controls = Array.from({ length: 17 }, (_, index) => ({ id: `button-${index}`, type: 'control-button' }))
  const fullPopup = { id: 'popup-full', type: 'control-popup', children: controls.slice(0, 16).map(item => item.id) }
  const graph = [...controls, fullPopup]
  assert.equal(assignControlToPopup(graph, fullPopup.id, controls[16].id), graph)
})

test('deletion cleans references while duplicated popups start empty', () => {
  const graph = [...components, { id: 'shift-a', type: 'operation-shifter', properties: { controlledComponentIds: ['button-a', 'button-b'], autoSequence: [{ id: 'step-a', componentId: 'button-a' }] } }]
  const removed = removeComponentsAndCleanPopups(graph, ['button-a'])
  assert.deepEqual(removed.find(item => item.id === 'popup-a').children, ['slider-a'])
  assert.deepEqual(removed.find(item => item.id === 'shift-a').properties.controlledComponentIds, ['button-b'])
  assert.deepEqual(removed.find(item => item.id === 'shift-a').properties.autoSequence, [])
  assert.deepEqual(copySafeComponent(components.find(item => item.id === 'popup-a')).children, [])
})
