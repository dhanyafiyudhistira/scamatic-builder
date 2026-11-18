import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sourceFiles = [
  '../src/App.jsx',
  '../src/BuilderPlatform.jsx',
  '../src/platform/ValidationConsole.jsx',
  '../src/runtime/RuntimeApp.jsx',
]

test('checklist controls and success indicators use the shared check.svg asset', async () => {
  const [icon, css, ...sources] = await Promise.all([
    read('../public/check.svg'),
    read('../src/builder.css'),
    ...sourceFiles.map(read),
  ])

  assert.match(icon, /<svg\b/)
  assert.match(icon, /<path\b/)
  assert.match(css, /input\[type="checkbox"\]::after\s*\{[\s\S]*?mask:\s*url\('\/check\.svg'\)/)
  assert.match(css, /\.sb-tag-value-control input\[type="checkbox"\]:checked::after\s*\{[\s\S]*?mask:\s*url\('\/check\.svg'\)/)
  const circularIndicatorRule = css.match(/\.sb-version-active-mark::before,\s*\.sb-validation-panel-result\.ok>\.sb-validation-ok-mark::before\s*\{([\s\S]*?)\}/)?.[1]
  assert.ok(circularIndicatorRule)
  assert.match(circularIndicatorRule, /mask:\s*url\('\/check\.svg'\)/)
  assert.doesNotMatch(circularIndicatorRule, /border-(?:right|bottom)/)
  assert.ok(sources.every(source => source.includes('src="/check.svg"')))
  assert.doesNotMatch(sources.join('\n'), /[✓✔☑]/)
})

function read(path) {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
