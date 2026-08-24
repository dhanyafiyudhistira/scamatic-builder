import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSvg } from '../api/_lib/svg.js'

const safeSvg = `<?xml version="1.0"?><svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>`

test('accepts a self-contained SVG and removes the XML declaration', () => {
  const result = sanitizeSvg(safeSvg)
  assert.match(result.svg, /^<svg/)
  assert.equal(result.viewBox, '0 0 100 100')
})

test('accepts exported SVG with BOM, prolog comments, and trailing whitespace', () => {
  const exported = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- Created by a vector editor -->\n<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">\n<!-- layer marker -->\n<rect width="640" height="480"/>\n</svg   >\n`
  const result = sanitizeSvg(exported)
  assert.match(result.svg, /^<svg/)
  assert.match(result.svg, /<\/svg\s*>$/)
  assert.equal(result.width, 640)
  assert.equal(result.height, 480)
})

test('parses and normalizes safe entities, styles, and internal references', () => {
  const result = sanitizeSvg('<svg viewBox="0 0 10 10"><defs><clipPath id="safe"><rect width="10" height="10"/></clipPath></defs><text clip-path="url(#safe)" style="fill:#fff;font-weight:600">A &amp; B</text></svg>')
  assert.match(result.svg, /clip-path="url\(#safe\)"/)
  assert.match(result.svg, /style="fill:#fff;font-weight:600"/)
  assert.match(result.svg, />A &amp; B</)
})

test('accepts Inkscape exports while removing editor-only metadata', () => {
  const exported = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 100 100" inkscape:version="1.4.2" sodipodi:docname="plant.svg"><sodipodi:namedview inkscape:current-layer="layer1"><inkscape:page x="0" y="0" width="100" height="100"/><foreign:editor-data value="discarded"/></sodipodi:namedview><defs><inkscape:path-effect effect="spiro" id="path-effect1"/></defs><g id="layer1" inkscape:groupmode="layer" inkscape:label="Main"><text style="font-family:Arial;-inkscape-font-specification:'Arial, Normal';fill:#111">SCADA</text><path d="M0 0L10 10" sodipodi:nodetypes="cc"/></g></svg>`
  const result = sanitizeSvg(exported)
  assert.match(result.svg, /<g id="layer1">/)
  assert.match(result.svg, /style="font-family:Arial;fill:#111"/)
  assert.doesNotMatch(result.svg, /inkscape|sodipodi|editor-data|namedview|path-effect/)
})

test('accepts standard typography styles emitted by Inkscape', () => {
  const style = "font-style:normal;font-variant:normal;font-weight:normal;font-stretch:normal;font-size:5.6px;font-family:Arial;-inkscape-font-specification:'Arial, Normal';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-variant-east-asian:normal;text-align:start;line-height:1.2;writing-mode:lr-tb;direction:ltr;text-anchor:start;fill:#111"
  const result = sanitizeSvg(`<svg viewBox="0 0 100 100"><text style="${style}">SCADA</text></svg>`)
  assert.match(result.svg, /font-stretch:normal/)
  assert.match(result.svg, /font-variant-ligatures:normal/)
  assert.match(result.svg, /text-align:start/)
  assert.doesNotMatch(result.svg, /-inkscape-font-specification/)
})

test('still rejects unknown namespaces outside discarded editor metadata', () => {
  assert.throws(() => sanitizeSvg('<svg viewBox="0 0 10 10"><rect vendor:action="https://evil.example"/></svg>'), /vendor:action is not allowed/)
  assert.throws(() => sanitizeSvg('<svg viewBox="0 0 10 10"><vendor:widget/></svg>'), /vendor:widget/)
})

for (const [name, payload] of [
  ['script element', '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>'],
  ['event handler', '<svg viewBox="0 0 10 10" onload="alert(1)"></svg>'],
  ['foreignObject', '<svg viewBox="0 0 10 10"><foreignObject/></svg>'],
  ['external href', '<svg viewBox="0 0 10 10"><image href="https://evil.example/x"/></svg>'],
  ['unquoted external href', '<svg viewBox="0 0 10 10"><image href=https://evil.example/x /></svg>'],
  ['CSS import', '<svg viewBox="0 0 10 10"><style>@import "https://evil.example/x.css";</style></svg>'],
  ['SMIL mutation', '<svg viewBox="0 0 10 10"><set attributeName="href" to="javascript:alert(1)"/></svg>'],
  ['doctype entity', '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 10 10"></svg>'],
  ['entity-obfuscated external CSS URL', '<svg viewBox="0 0 10 10"><rect style="fill:&#x75;rl(&#x68;ttps://evil.example/x)"/></svg>'],
  ['mismatched nesting', '<svg viewBox="0 0 10 10"><g><rect/></svg></g>'],
  ['unknown active-looking attribute', '<svg viewBox="0 0 10 10"><rect formaction="https://evil.example"/></svg>'],
]) {
  test(`rejects ${name}`, () => assert.throws(() => sanitizeSvg(payload)))
}
