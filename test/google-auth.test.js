import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createGoogleOAuthTransaction, googleOAuthConfiguration, normalizeOAuthNext, readGoogleOAuthTransaction } from '../api/_handlers/google-auth.js'

const productionConfiguration = {
  NODE_ENV: 'production',
  GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'https://scada-dhany-wtp.vercel.app/api/auth/callback/google',
}

test('Google OAuth configuration requires the exact secure callback shape', () => {
  assert.equal(googleOAuthConfiguration(productionConfiguration).ok, true)
  assert.equal(googleOAuthConfiguration({ ...productionConfiguration, GOOGLE_REDIRECT_URI: 'http://scada-dhany-wtp.vercel.app/api/auth/callback/google' }).ok, false)
  assert.equal(googleOAuthConfiguration({ ...productionConfiguration, GOOGLE_REDIRECT_URI: 'https://scada-dhany-wtp.vercel.app/api/auth/google/callback' }).ok, false)
  assert.equal(googleOAuthConfiguration({ ...productionConfiguration, GOOGLE_CLIENT_SECRET: '' }).ok, false)
  assert.equal(googleOAuthConfiguration({
    ...productionConfiguration,
    NODE_ENV: 'development',
    GOOGLE_REDIRECT_URI: 'http://localhost:5173/api/auth/callback/google',
  }).ok, true)
})

test('Google OAuth next path remains same-origin and bounded', () => {
  assert.equal(normalizeOAuthNext('/'), '/')
  assert.equal(normalizeOAuthNext('/runtime/demo?metrics=1'), '/runtime/demo?metrics=1')
  assert.equal(normalizeOAuthNext('https://attacker.example'), '/')
  assert.equal(normalizeOAuthNext('//attacker.example/path'), '/')
  assert.equal(normalizeOAuthNext('/\\attacker.example'), '/')
})

test('Google OAuth transaction is signed, expiring, and uses PKCE', () => {
  const configuration = googleOAuthConfiguration(productionConfiguration)
  const now = Date.now()
  const transaction = createGoogleOAuthTransaction(configuration, '/runtime/demo', now)
  const cookieValue = decodeURIComponent(transaction.cookie.match(/^scada_google_oauth=([^;]+)/)[1])
  const restored = readGoogleOAuthTransaction(cookieValue, configuration, now + 1000)
  const authorizationUrl = new URL(transaction.authorizationUrl)

  assert.equal(restored.next, '/runtime/demo')
  assert.equal(restored.state, authorizationUrl.searchParams.get('state'))
  assert.equal(restored.nonce, authorizationUrl.searchParams.get('nonce'))
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), productionConfiguration.GOOGLE_REDIRECT_URI)
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(authorizationUrl.searchParams.get('code_challenge'))
  assert.equal(readGoogleOAuthTransaction(`${cookieValue.slice(0, -1)}x`, configuration, now + 1000), null)
  assert.equal(readGoogleOAuthTransaction(cookieValue, configuration, now + 11 * 60_000), null)
})

test('environment example contains no Google secret and no duplicate active keys', async () => {
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8')
  const activeKeys = example
    .split(/\r?\n/)
    .map(line => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
    .filter(Boolean)

  assert.equal(/GOCSPX-[A-Za-z0-9_-]+/.test(example), false)
  assert.match(example, /^GOOGLE_CLIENT_SECRET=replace-with-google-client-secret$/m)
  assert.match(example, /^VITE_GOOGLE_AUTH_URL=\/api\/auth\/google\/start\?next=%2F$/m)
  assert.equal(new Set(activeKeys).size, activeKeys.length)
})
