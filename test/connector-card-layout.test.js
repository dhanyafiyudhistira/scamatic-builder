import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('connector cards allow long names and actions to wrap inside a narrow sidebar', async () => {
  const css = await readFile(new URL('../src/builder.css', import.meta.url), 'utf8')
  const header = rule(css, '.sb-connector-card-header')
  const title = rule(css, '.sb-connector-card-header>strong')
  const action = rule(css, '.sb-connector-card-actions button')

  assert.match(header, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/)
  assert.match(title, /overflow-wrap:\s*anywhere/)
  assert.match(action, /white-space:\s*normal/)
  assert.match(action, /overflow-wrap:\s*anywhere/)
  assert.doesNotMatch(action, /white-space:\s*nowrap/)
})

test('ThingsBoard account action uses the standard connector button tone', async () => {
  const [css, connectorManager] = await Promise.all([
    readFile(new URL('../src/builder.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/platform/ConnectorManager.jsx', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(connectorManager, /sb-connector-auth-active/)
  assert.doesNotMatch(css, /\.sb-connector-card-actions \.sb-connector-auth-active/)
})

test('ThingsBoard account form keeps compact balanced actions in a narrow card', async () => {
  const [css, connectorManager] = await Promise.all([
    readFile(new URL('../src/builder.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/platform/ConnectorManager.jsx', import.meta.url), 'utf8'),
  ])
  const actions = rule(css, '.sb-connector-auth-actions')
  const buttons = rule(css, '.sb-connector-auth-actions button')

  assert.match(actions, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(buttons, /min-width:\s*0/)
  assert.match(buttons, /white-space:\s*nowrap/)
  assert.match(connectorManager, /autoRefresh \? 'Reconnect' : 'Connect'/)
  assert.doesNotMatch(connectorManager, /Connect & enable auto-refresh/)
})

test('connector information control stays compact and perfectly circular', async () => {
  const css = await readFile(new URL('../src/builder.css', import.meta.url), 'utf8')
  const infoButton = rule(css, '.sb-connector-info-trigger')

  assert.match(infoButton, /width:\s*18px\s*!important/)
  assert.match(infoButton, /height:\s*18px\s*!important/)
  assert.match(infoButton, /aspect-ratio:\s*1/)
  assert.match(infoButton, /border-radius:\s*50%\s*!important/)
  assert.match(infoButton, /background-image:\s*none\s*!important/)
  assert.match(css, /\.sb-connector-info-trigger::before,\s*\.sb-connector-info-trigger::after\s*\{[^}]*left:\s*50%;[^}]*width:\s*1\.5px/)
  assert.match(css, /\.sb-connector-info-trigger::after\s*\{[^}]*height:\s*5\.25px/)
})

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `Missing CSS rule for ${selector}`)
  return match[1]
}
