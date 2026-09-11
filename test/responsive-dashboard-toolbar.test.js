import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('responsive dashboard toolbar wraps breakpoints in Preference and uses the shared info popover', async () => {
  const source = await readFile(new URL('../src/BuilderPlatform.jsx', import.meta.url), 'utf8')
  const toolbar = source.slice(source.indexOf('function DashboardBreakpointToolbar('), source.indexOf('function moveResponsiveSelection('))

  assert.match(toolbar, /HeaderMenuTrigger label="Preference"/)
  assert.match(toolbar, /DASHBOARD_BREAKPOINTS\.map/)
  assert.match(toolbar, /<InfoPopover className="sb-dashboard-breakpoint-info"/)
  assert.doesNotMatch(toolbar, /sb-dashboard-breakpoint-tabs|sb-dashboard-breakpoint-meta/)
})
