import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('additional information uses one accessible structured popover blueprint', async () => {
  const [component, builder, connectorManager, runtime, styles] = await Promise.all([
    readFile(new URL('../src/platform/InfoPopover.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/BuilderPlatform.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/platform/ConnectorManager.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtime/RuntimeApp.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/builder.css', import.meta.url), 'utf8'),
  ])

  assert.match(component, /aria-expanded=\{open\}/)
  assert.match(component, /aria-controls=\{panelId\}/)
  assert.match(component, /FOCUSABLE_SELECTOR/)
  assert.match(component, /surfaceRole !== 'dialog'/)
  assert.match(component, /event\.key !== 'Tab'/)
  assert.match(component, /event\.preventDefault\(\)/)
  assert.match(component, /controls\.at\(-1\)/)
  assert.match(component, /tabIndex=\{surfaceRole === 'dialog' \? -1 : undefined\}/)
  assert.match(component, /document\.addEventListener\('pointerdown', close\)/)
  assert.match(component, /closePopover\(\{ restoreFocus: true \}\)/)
  assert.match(component, /getBoundingClientRect\(\)/)
  assert.match(component, /window\.addEventListener\('scroll', placeSurface, true\)/)
  assert.match(component, /Math\.min\(Math\.max\(preferredLeft, margin\), maximumLeft\)/)
  assert.match(component, /createPortal\(<div className=\{`sb-info-portal/)
  assert.match(component, /surfaceRef\.current\?\.contains\(event\.target\)/)
  assert.match(component, /className="sb-info-section"/)
  assert.match(builder, /<InfoPopover className="sb-isaac-info"/)
  assert.match(builder, /<InfoPopoverSection key=\{modeId\}/)
  assert.match(builder, /title="Published history" titleInfo=\{<>/)
  assert.match(builder, /<InfoPopover className="sb-panel-title-info"/)
  assert.match(builder, /className="sb-panel-heading-controls"><InfoPopover[\s\S]*<i className="sb-panel-chevron"/)
  assert.match(builder, /<InfoPopover className="sb-version-info"[\s\S]*surfaceRole="dialog" dismissOnAction/)
  assert.doesNotMatch(builder, /sb-version-details-trigger/)
  assert.match(connectorManager, /<InfoPopover className="sb-connector-info"/)
  assert.match(connectorManager, /<InfoPopoverSection title="RUNTIME HEALTH">/)
  assert.match(runtime, /<InfoPopover className="sb-runtime-message-info"[\s\S]*align="end"/)
  assert.doesNotMatch(runtime, /<details className="sb-runtime-message-info"/)
  assert.match(styles, /\.sb-info-trigger[\s\S]*border-radius: 50%/)
  assert.match(styles, /\.sb-info-surface[\s\S]*position: fixed;[\s\S]*box-shadow:/)
  assert.match(styles, /\.sb-info-surface:focus-visible\s*\{[^}]*outline:/s)
  assert.match(styles, /\.sb-info-intro\+\.sb-info-section[\s\S]*border-top:/)
  assert.match(styles, /\.sb-panel-heading-controls\s*\{[^}]*align-items:\s*center;[^}]*gap:\s*14px;/s)
})
