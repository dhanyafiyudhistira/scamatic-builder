const finishes = {
  pump: '#728c9a',
  valve: '#7f8b77',
  motor: '#8f8475',
  tank: '#7a8c98',
  conveyor: '#8c8875',
  exchanger: '#758d89',
  blower: '#758995',
  compressor: '#8f8378',
  mixer: '#808a7a',
  instrument: '#788a96',
  pipe: '#818b91',
}

export const arcTokens = {
  'equipment.detail': '#c0c9c5',
  'equipment.body-strong': '#aebdbb',
  'state.stopped': '#a4ad8f',
}

const surfaces = {
  body: 'shell',
  'body-secondary': 'hardware',
  nozzle: 'hardware',
  flange: 'hardware',
  base: 'foot',
  fill: 'liquid',
  indicator: 'lens',
  product: 'cargo',
}

const roundCasings = new Set(['pump', 'blower', 'instrument'])

function mix(first, second, amount) {
  const channel = start => {
    const a = parseInt(first.slice(start, start + 2), 16)
    const b = parseInt(second.slice(start, start + 2), 16)
    return Math.round(a + (b - a) * amount).toString(16).padStart(2, '0')
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

function stops(values) {
  return values.map(([offset, color]) => `<stop offset="${offset}" stop-color="${color}"/>`).join('')
}

function metalStops(base) {
  return [
    ['0%', mix(base, '#20292e', 0.29)],
    ['13%', mix(base, '#e2e8de', 0.49)],
    ['36%', mix(base, '#d3ddd6', 0.23)],
    ['58%', base],
    ['90%', mix(base, '#263139', 0.67)],
    ['100%', mix(base, '#263139', 0.38)],
  ]
}

// Keep the source renderer's silhouette, group order, clips and transforms.
// Only its self-closing shapes in solid regions receive the new surface paint.
export function applyArcFinish(svg, object, prefix) {
  const family = object.identity.family
  const metal = finishes[family] ?? '#818b91'
  const upright = family === 'tank' && object.generator.params.orientation !== 'horizontal'
  const bend = family === 'pipe' && object.identity.kind !== 'spool'
  const axis = 'x1="0%" y1="0%" x2="0%" y2="100%"'
  const crossAxis = 'x1="0%" y1="0%" x2="100%" y2="0%"'
  const id = name => `${prefix}-arc-${name}`
  const paint = name => `url(#${id(name)})`
  const linear = (name, direction, values) => `<linearGradient id="${id(name)}" ${direction}>${stops(values)}</linearGradient>`
  const radial = (name, values) => `<radialGradient id="${id(name)}" cx="44%" cy="41%" fx="27%" fy="23%" r="69%">${stops(values)}</radialGradient>`

  const defs = [
    linear('shell', upright ? crossAxis : axis, metalStops(metal)),
    radial('rounded-shell', [
      ['0%', mix(metal, '#e2e8de', 0.56)],
      ['37%', mix(metal, '#d3ddd6', 0.27)],
      ['68%', metal],
      ['96%', mix(metal, '#233038', 0.68)],
      ['100%', mix(metal, '#b6c2be', 0.27)],
    ]),
    linear('hardware', axis, metalStops(mix(metal, '#a8aaa0', 0.42))),
    linear('foot', axis, metalStops(mix(metal, '#43494c', 0.55))),
    linear('liquid', upright ? crossAxis : axis, metalStops('#5c7d86')),
    radial('lens', [['0%', '#d2d8ba'], ['47%', '#a1ad8f'], ['84%', '#67775f'], ['100%', '#465849']]),
    linear('cargo', axis, metalStops('#9d8b72')),
    linear('rim', axis, [['0%', '#c2ceca'], ['45%', '#849392'], ['100%', '#435258']]),
    `<pattern id="${id('grain')}" patternUnits="userSpaceOnUse" width="11" height="7">
      <path d="M-2 5 Q4 1 12 4" fill="none" stroke="#dde5db" stroke-width=".35" stroke-opacity=".28"/>
      <path d="M-1 6 Q5 2 13 5" fill="none" stroke="#263338" stroke-width=".32" stroke-opacity=".22"/>
    </pattern>`,
  ].join('')

  const materialized = svg.replace(
    /(<g\b[^>]* class="vt-region vt-role--([a-z-]+) vt-paint--solid"[^>]*>)([\s\S]*?)(<\/g>)/g,
    (group, opening, role, body, closing) => {
      const surface = surfaces[role]
      if (!surface) return group
      const metalBody = ['shell', 'hardware', 'foot', 'cargo'].includes(surface)
      const shadedShapes = body.replace(/<(path|rect|circle|ellipse)\b[^>]*\/>/g, (shape, kind) => {
        const round = kind === 'circle' || kind === 'ellipse' || roundCasings.has(family) || bend
        const finish = surface === 'shell' && round ? 'rounded-shell' : surface
        const rim = metalBody ? ` stroke="${paint('rim')}"` : ''
        const paintShape = shape.replace('/>', ` fill="${paint(finish)}"${rim}/>`)
        if (!metalBody) return paintShape
        const texture = shape.replace('/>', ` fill="${paint('grain')}" stroke="none" opacity=".48"/>`)
        return paintShape + texture
      })
      return opening + shadedShapes + closing
    },
  )

  const readable = family === 'instrument'
    ? materialized.replace(/(<g\b[^>]* data-region="(?:tag-letters|loop-number)"[^>]*? stroke=")[^"]+/g, '$1#26363d')
    : materialized
  return readable.replace('</title>', `</title><defs>${defs}</defs>`)
}
