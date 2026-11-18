import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { IOT_DASHBOARD_PROJECT_TYPE, projectTypeMetadata } from '../shared/project-type.js'

test('IoT Dashboard inherits the global black/cyan palette without a blue override', async () => {
  const css = await readFile(new URL('../src/builder.css', import.meta.url), 'utf8')
  const retiredBluePalette = /#(?:7c9cff|5874cb|17264c|182750|4a63aa|bdcbff|3656a5|6887ee|405993|cbd6ff|e3e9ff|aab9e8|0b1020|0e1426|151d35|2d3d64|30436d|7594ff)/i

  assert.equal(projectTypeMetadata(IOT_DASHBOARD_PROJECT_TYPE).canvas.background, '#081018')
  assert.doesNotMatch(css, retiredBluePalette)
  assert.match(css, /\.sb-project-card\.mode-iot-dashboard[\s\S]*?border-color: var\(--sb-accent-border\)/)
  assert.match(css, /\.sb-iot-create-note,[\s\S]*?border: 1px solid var\(--sb-accent-border\)/)
})
