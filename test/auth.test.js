import test from 'node:test'
import assert from 'node:assert/strict'
import { bootstrapOwnerId, hashPassword, parseCookies, passwordChangeError, requireAllowedOrigin, signupValidationError, verifyPassword } from '../api/_lib/auth.js'
import { capabilitiesForRole, PERMISSIONS, roleCan, roleMeetsRequirement } from '../api/_lib/authorization.js'
import { isDatabaseUnavailableError } from '../api/_lib/security.js'

test('password hashing uses a unique salt and verifies without plaintext storage', async () => {
  const first = await hashPassword('correct horse battery staple')
  const second = await hashPassword('correct horse battery staple')
  assert.notEqual(first, second)
  assert.equal(await verifyPassword('correct horse battery staple', first), true)
  assert.equal(await verifyPassword('wrong', first), false)
  assert.equal(first.includes('correct horse'), false)
})

test('password change validation requires a new confirmed password with safe bounds', () => {
  assert.equal(passwordChangeError({}), 'Enter your current password.')
  assert.equal(passwordChangeError({ currentPassword: 'old-password', newPassword: 'short', confirmPassword: 'short' }), 'New password must contain at least 10 characters.')
  assert.equal(passwordChangeError({ currentPassword: 'same-password', newPassword: 'same-password', confirmPassword: 'same-password' }), 'New password must be different from the current password.')
  assert.equal(passwordChangeError({ currentPassword: 'old-password', newPassword: 'new-password', confirmPassword: 'different' }), 'New password confirmation does not match.')
  assert.equal(passwordChangeError({ currentPassword: 'old-password', newPassword: 'new-password', confirmPassword: 'new-password' }), null)
})

test('self-registration validates email and confirmed password bounds', () => {
  assert.equal(signupValidationError({ email: 'invalid', password: 'long-enough-password', confirmPassword: 'long-enough-password' }), 'Enter a valid email address.')
  assert.equal(signupValidationError({ email: 'user@example.com', password: 'short', confirmPassword: 'short' }), 'Password must contain at least 10 characters.')
  assert.equal(signupValidationError({ email: 'user@example.com', password: 'long-enough-password', confirmPassword: 'different-password' }), 'Password confirmation does not match.')
  assert.equal(signupValidationError({ email: ' User@Example.com ', password: 'long-enough-password', confirmPassword: 'long-enough-password' }), null)
})

test('bootstrap owner IDs are deterministic per normalized email without colliding globally', () => {
  assert.equal(bootstrapOwnerId(' Owner@SCADA.local '), bootstrapOwnerId('owner@scada.local'))
  assert.notEqual(bootstrapOwnerId('owner@scada.local'), bootstrapOwnerId('recovery@scada.local'))
  assert.match(bootstrapOwnerId('owner@scada.local'), /^owner-[a-f0-9]{24}$/)
})

test('cookie parser handles multiple encoded cookies', () => {
  assert.deepEqual(parseCookies('scada_session=abc; scada_csrf=a%2Fb; theme=dark'), { scada_session: 'abc', scada_csrf: 'a/b', theme: 'dark' })
  assert.deepEqual(parseCookies('valid=ok; malformed=%E0%A4%A'), { valid: 'ok' })
})

test('mutation origin validation rejects an unconfigured origin', () => {
  let status = null; let body = null
  const res = { status(value) { status = value; return this }, json(value) { body = value; return value } }
  assert.equal(requireAllowedOrigin({ headers: { origin: 'https://attacker.example' } }, res), false)
  assert.equal(status, 403)
  assert.equal(body.code, 'ORIGIN_REJECTED')
  assert.equal(requireAllowedOrigin({ headers: { origin: 'http://localhost:5173' } }, res), true)
})

test('RBAC capability matrix denies publish and commands by default', () => {
  assert.equal(roleCan('OWNER', PERMISSIONS.PROJECT_PUBLISH), true)
  assert.equal(roleCan('ADMIN', PERMISSIONS.PROJECT_PUBLISH), true)
  assert.equal(roleCan('OWNER', PERMISSIONS.CHART_STORAGE_MANAGE), true)
  assert.equal(roleCan('ADMIN', PERMISSIONS.CHART_STORAGE_MANAGE), true)
  assert.equal(roleCan('EDITOR', PERMISSIONS.CHART_STORAGE_MANAGE), false)
  assert.equal(roleCan('EDITOR', PERMISSIONS.PROJECT_PUBLISH), false)
  assert.equal(roleCan('EDITOR', PERMISSIONS.BUILDER_WRITE), true)
  assert.equal(roleCan('OPERATOR', PERMISSIONS.RUNTIME_VIEW), true)
  assert.equal(roleCan('OPERATOR', PERMISSIONS.BUILDER_READ), false)
  assert.equal(roleCan('OPERATOR', PERMISSIONS.COMMAND_EXECUTE), true)
  assert.equal(roleCan('VIEWER', PERMISSIONS.RUNTIME_VIEW), true)
  assert.equal(roleCan('VIEWER', PERMISSIONS.COMMAND_EXECUTE), false)
  assert.equal(roleMeetsRequirement('OPERATOR', 'OPERATOR'), true)
  assert.equal(roleMeetsRequirement('VIEWER', 'OPERATOR'), false)
  assert.equal(roleMeetsRequirement('ADMIN', 'ADMIN'), true)
  assert.equal(roleMeetsRequirement('OPERATOR', 'ADMIN'), false)
  assert.deepEqual(capabilitiesForRole('UNKNOWN'), [])
})

test('database connectivity failures are classified without exposing internals', () => {
  assert.equal(isDatabaseUnavailableError(Object.assign(new Error('connect ETIMEDOUT'), { name: 'MongoNetworkError' })), true)
  assert.equal(isDatabaseUnavailableError(new Error('querySrv ENOTFOUND _mongodb._tcp.cluster.example')), true)
  assert.equal(isDatabaseUnavailableError(new Error('validation failed')), false)
})
