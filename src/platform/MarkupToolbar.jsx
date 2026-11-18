import { lazy, Suspense, useState } from 'react'
import { MARKUP_TOOLS } from '../../shared/markup-stroke.js'
import { MarkupGeometry, MarkupIcon } from './MarkupLayer.jsx'

const drawingTools = Object.entries(MARKUP_TOOLS)
const PaletteContents = lazy(async () => {
  const { grindstoneSymbols } = await import('./MarkupSymbols.jsx')
  return { default: props => <MarkupPalette {...props} symbols={grindstoneSymbols} /> }
})

function ToolIcon({ tool }) {
  if (tool === 'pencil') return <MarkupIcon />
  if (tool === 'select') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="m5 3 14 9-7 1-3 7z" /></svg>
  if (tool === 'text') return <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
    <path d="M208,56V88a8,8,0,0,1-16,0V64H136V192h24a8,8,0,0,1,0,16H96a8,8,0,0,1,0-16h24V64H64V88a8,8,0,0,1-16,0V56a8,8,0,0,1,8-8H200A8,8,0,0,1,208,56Z" />
  </svg>
  return <MarkupGeometry icon width={24} height={24} properties={{ tool, points: [[.04, .92], [.96, .08]], cornerRadius: 5, color: 'currentColor', strokeWidth: 1.5 }} />
}

export function MarkupToolbar({ tool, onTool, expanded, onToggle }) {
  const [search, setSearch] = useState('')
  return <aside className={`sb-markup-toolbar-wrap${expanded ? ' is-expanded' : ''}`} aria-label="Markup tools">
    <div className="sb-markup-palette-heading">
      <button type="button" className="sb-markup-palette-toggle" aria-label={expanded ? 'Collapse markup palette' : 'Expand markup palette'} title={expanded ? 'Collapse markup palette' : 'Expand markup palette'} aria-expanded={expanded} aria-controls="sb-markup-palette" onClick={onToggle}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={expanded ? 'm13 6-6 6 6 6m6-12-6 6 6 6' : 'm5 6 6 6-6 6m6-12 6 6-6 6'} /></svg>
      </button>
      {expanded && <strong>Markup tools</strong>}
    </div>
    {expanded ? <>
      <input type="search" className="sb-markup-search" aria-label="Search tools and symbols" placeholder="Search tools and symbols" value={search} maxLength={64} onChange={event => setSearch(event.target.value)} />
      <div className="sb-markup-palette-scroll" id="sb-markup-palette">
        <Suspense fallback={<p className="sb-markup-palette-message" role="status">Loading tools…</p>}>
          <PaletteContents tool={tool} onTool={onTool} query={search.trim().toLowerCase()} />
        </Suspense>
      </div>
    </> : <div className="sb-markup-compact-tools" id="sb-markup-palette">
      <div className="sb-markup-draw-tools" role="group" aria-label="Markup drawing tools">
        {[['select', 'Select / move'], ...drawingTools].map(([id, label]) => <DrawingButton key={id} id={id} label={label} tool={tool} onTool={onTool} />)}
      </div>
      <div className="sb-markup-actions">
        <button type="button" title="Grindstone industrial symbols" aria-label="Industrial · Grindstone" aria-pressed={tool.id === 'symbol'} onClick={() => { setSearch(''); onToggle() }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 20V9l6 4V9l6 4V6h4l2 14H3Zm4-3h2m3 0h2m3 0h1" /></svg>
        </button>
      </div>
    </div>}
  </aside>
}

function MarkupPalette({ tool, onTool, query, symbols }) {
  const industrialTitle = 'Industrial · Grindstone'
  const matches = (...terms) => terms.join(' ').toLowerCase().includes(query)
  const filteredSymbols = symbols.filter(symbol => matches(symbol.id, symbol.label, industrialTitle))
  const filteredDrawing = drawingTools.filter(([id, label]) => matches(id, label, 'Decoration markup'))
  const showSelect = matches('Select / move')
  return <>
    {showSelect && <DrawingButton id="select" label="Select / move" tool={tool} onTool={onTool} showLabel />}
    {filteredSymbols.length > 0 && <PaletteGroup title={industrialTitle} id="sb-markup-industrial" defaultOpen searching={Boolean(query)}>
      {filteredSymbols.map(symbol => <button key={symbol.id} type="button" className="sb-markup-palette-row" aria-pressed={tool.symbol?.id === symbol.id} onClick={() => onTool({ id: 'symbol', symbol })}>
        <img src={symbol.src} alt="" draggable={false} />
        <span>{symbol.label}</span>
      </button>)}
    </PaletteGroup>}
    {filteredDrawing.length > 0 && <PaletteGroup title="Decoration" id="sb-markup-decoration" defaultOpen={tool.id !== 'select' && !tool.symbol} searching={Boolean(query)}>
      {filteredDrawing.map(([id, label]) => <DrawingButton key={id} id={id} label={label} tool={tool} onTool={onTool} showLabel />)}
    </PaletteGroup>}
    {!showSelect && filteredSymbols.length === 0 && filteredDrawing.length === 0 && <p className="sb-markup-palette-message" role="status">No matching tools or symbols.</p>}
  </>
}

function DrawingButton({ id, label, tool, onTool, showLabel }) {
  return <button type="button" className={showLabel ? 'sb-markup-palette-row' : undefined} aria-label={label} title={label} aria-pressed={tool.id === id} onClick={() => onTool({ id })}>
    <ToolIcon tool={id} />{showLabel && <span>{label}</span>}
  </button>
}

function PaletteGroup({ title, id, defaultOpen = false, searching, children }) {
  const [open, setOpen] = useState(defaultOpen)
  const showItems = searching || open
  return <div className="sb-markup-palette-group">
    <button type="button" className="sb-markup-palette-group-button" aria-expanded={showItems} aria-controls={id} disabled={searching} onClick={() => setOpen(value => !value)}>
      <i aria-hidden="true" /><span>{title}</span>
    </button>
    <div id={id} role="group" aria-label={title} hidden={!showItems} className="sb-markup-palette-list">{children}</div>
  </div>
}
