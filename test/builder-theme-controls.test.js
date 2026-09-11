import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Builder keeps theme tone global and omits duplicate canvas controls', async () => {
  const source = await readFile(new URL('../src/BuilderPlatform.jsx', import.meta.url), 'utf8')
  const viewMenu = source.slice(source.indexOf('function ViewMenu('), source.indexOf('function HeaderMenuTrigger('))
  const preview = source.slice(source.indexOf('if (preview)'), source.indexOf('const selected ='))

  assert.doesNotMatch(viewMenu, /Theme tone|themeTone|onThemeToneChange/)
  assert.doesNotMatch(preview, /ThemeToneToggle/)
  assert.match(source, /<div className="sb-settings-section"><small>Appearance<\/small><ThemeToneToggle \/><\/div>/)
})
