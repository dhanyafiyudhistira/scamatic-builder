import test from 'node:test'
import assert from 'node:assert/strict'
import { validationNoticeDetails } from '../shared/validation-notice.js'

test('validation notices expose blocking errors with their schema paths before warnings', () => {
  const details = validationNoticeDetails([
    { severity: 'warning', message: 'Component is outside the canvas.', path: 'components.2.position' },
    { severity: 'error', message: 'Command tag is read-only.', path: 'components.4.binding.tagId' },
  ])
  assert.deepEqual(details, [
    { severity: 'error', message: 'Command tag is read-only.', path: 'components.4.binding.tagId' },
    { severity: 'warning', message: 'Component is outside the canvas.', path: 'components.2.position' },
  ])
})

test('validation notices remain empty for ordinary API errors', () => {
  assert.deepEqual(validationNoticeDetails(undefined), [])
})

test('validation notices stay bounded and report omitted issues', () => {
  const issues = Array.from({ length: 4 }, (_, index) => ({ severity: 'error', message: `Error ${index + 1}`, path: `tags.${index}` }))
  const details = validationNoticeDetails(issues, 2)
  assert.equal(details.length, 3)
  assert.match(details.at(-1).message, /2 additional/)
})
