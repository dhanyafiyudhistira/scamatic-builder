import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('IoT components use a scoped matte skin without changing SCADA silhouettes', async () => {
  const css = await readFile(new URL('../src/builder.css', import.meta.url), 'utf8')
  const marker = '/* IoT Dashboard components: original silhouettes with a low-glare matte skin. */'
  const theme = css.slice(css.indexOf(marker))

  assert.ok(theme.startsWith(marker))
  assert.match(theme, /\.sb-app\.mode-iot-dashboard/)
  assert.match(theme, /\.sb-preview-page\.mode-iot-dashboard/)
  assert.match(theme, /\.sb-published-runtime\.mode-iot-dashboard/)
  for (const componentClass of [
    'sb-value-component',
    'sb-lamp-component',
    'sb-alarm-component',
    'sb-gauge-component',
    'sb-control-component',
    'sb-chart-launcher',
    'sb-tuning-component',
    'sb-operation-shifter-trigger',
    'sb-control-popup-launcher',
  ]) {
    assert.match(theme, new RegExp(`mode-iot-dashboard[\\s\\S]*?\\.${componentClass}`))
  }
  assert.match(theme, /--sb-iot-matte-texture:/)
  assert.doesNotMatch(theme, /clip-path:/)
  assert.doesNotMatch(theme, /border-radius:\s*(?:1[0-9]|[2-9][0-9])px/)
  assert.doesNotMatch(theme, /\.mode-scada/)
})
