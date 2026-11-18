import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('telemetry legend separates each series label from its latest value', async () => {
  const css = await readFile(new URL('../src/builder.css', import.meta.url), 'utf8')
  const legend = css.slice(css.indexOf('.sb-chart-legend>div'), css.indexOf('.sb-chart-plot'))

  assert.match(legend, /column-gap: 10px/)
  assert.match(legend, /row-gap: 6px/)
  assert.match(legend, /padding: 7px 10px/)
  assert.match(legend, /grid-row: 1 \/ span 2/)
  assert.match(legend, /sb-chart-legend strong[\s\S]*\/1\.25 var\(--sb-chart-font\)/)
})

test('expanded chart uses an accessible icon-only minimize control', async () => {
  const runtime = await readFile(new URL('../src/platform/RuntimeCanvas.jsx', import.meta.url), 'utf8')
  const button = runtime.match(/<button[^>]*aria-label="Minimize chart"[^>]*>[\s\S]*?<\/button>/)?.[0] || ''

  assert.match(button, /aria-label="Minimize chart"/)
  assert.match(button, /title="Minimize chart"/)
  assert.match(button, /<span aria-hidden="true">—<\/span>/)
  assert.doesNotMatch(button, /<\/span>\s+Minimize/)
})
