import test from 'node:test'
import assert from 'node:assert/strict'
import { arrangeSelection, moveSelection, resizeComponentBounds, resolveSmartSnap, selectionBounds } from '../shared/placement.js'

const component = (id, x, y, width = 100, height = 60, locked = false) => ({ id, locked, position: { x, y, width, height, rotation: 0 } })

test('selection bounds cover components with different dimensions', () => {
  assert.deepEqual(selectionBounds([component('a', 10, 20), component('b', 160, 90, 80, 40)]), { x: 10, y: 20, width: 230, height: 110 })
})

test('group movement preserves spacing and clamps the whole selection to canvas', () => {
  const moved = moveSelection([component('a', 10, 20), component('b', 160, 80)], ['a', 'b'], -80, 300, { width: 400, height: 200 })
  assert.deepEqual(moved.map(item => [item.position.x, item.position.y]), [[0, 80], [150, 140]])
})

test('locked members stay in place during group movement', () => {
  const moved = moveSelection([component('a', 10, 20), component('b', 160, 80, 100, 60, true)], ['a', 'b'], 20, 10, { width: 400, height: 200 })
  assert.deepEqual(moved.map(item => [item.position.x, item.position.y]), [[30, 30], [160, 80]])
})

test('resize handles stay inside canvas edges and can resize from every side', () => {
  const canvas = { width: 400, height: 200 }
  const position = { x: 250, y: 100, width: 150, height: 100, rotation: 0 }
  assert.deepEqual(resizeComponentBounds(position, 'se', 80, 50, canvas), position)
  assert.deepEqual(resizeComponentBounds(position, 'nw', -400, -300, canvas), { x: 0, y: 0, width: 400, height: 200, rotation: 0 })
  assert.deepEqual(resizeComponentBounds(position, 'w', 140, 0, canvas), { x: 376, y: 100, width: 24, height: 100, rotation: 0 })
})

test('corner resizing can preserve image aspect ratio at board boundaries', () => {
  const resized = resizeComponentBounds(
    { x: 100, y: 50, width: 200, height: 100, rotation: 0 },
    'se',
    500,
    10,
    { width: 400, height: 220 },
    { lockAspect: true },
  )
  assert.deepEqual(resized, { x: 100, y: 50, width: 300, height: 150, rotation: 0 })
})

test('smart snapping resolves closest edge or center anchor on both axes', () => {
  assert.deepEqual(resolveSmartSnap({ x: 97, y: 45, width: 50, height: 50 }, [{ x: 100, y: 100, width: 100, height: 100 }], 5), {
    dx: 3, dy: 5, xGuide: 100, yGuide: 100,
  })
})

test('alignment and distribution update only selected unlocked components', () => {
  const components = [component('a', 10, 10, 20), component('b', 70, 30, 20), component('c', 150, 50, 20), component('d', 300, 5, 20, 60, true)]
  const aligned = arrangeSelection(components, ['a', 'b', 'c', 'd'], 'top')
  assert.deepEqual(aligned.map(item => item.position.y), [10, 10, 10, 5])
  const distributed = arrangeSelection(components, ['a', 'b', 'c'], 'distribute-x')
  assert.deepEqual(distributed.map(item => item.position.x), [10, 80, 150, 300])
})
