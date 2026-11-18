import { useEffect, useRef, useState } from 'react'
import { MARKUP_TOOLS } from '../../shared/markup-stroke.js'
import { MarkupToolbar } from './MarkupToolbar.jsx'

export function MarkupWorkspace({ tool, onTool, onBack, canvas, properties, layers, layerCount, zoom, dirty, saving, saveDialog, onContinue, dimensions }) {
  const [paletteExpanded, setPaletteExpanded] = useState(true)
  const toolName = tool.symbol?.label || MARKUP_TOOLS[tool.id] || 'Select'
  const instruction = tool.symbol ? 'Click the canvas to place the symbol.'
    : tool.id === 'select' ? 'Select or resize a markup layer.'
      : tool.id === 'text' ? 'Click or drag to add an annotation.' : 'Drag on the canvas to draw.'

  return <div className="sb-markup-workspace">
    <div className="sb-markup-workspace-body" inert={saving ? '' : undefined}>
      <main className={`sb-markup-stage${paletteExpanded ? ' has-expanded-palette' : ''}`} aria-label="Markup canvas">
        {canvas}
        <MarkupToolbar tool={tool} onTool={onTool} expanded={paletteExpanded} onToggle={() => setPaletteExpanded(value => !value)} />
      </main>
      <aside className="sb-markup-dock" aria-label="Markup panels">
        <section><h2>Properties</h2><div className="sb-markup-dock-content">{properties}</div></section>
        <section><h2>Layers <span>{layerCount}</span></h2><div className="sb-markup-dock-content">{layers}</div></section>
      </aside>
    </div>
    <footer className="sb-markup-status">
      <span className="sb-markup-metrics"><span>{Math.round(zoom * 100)}%</span><span>{dimensions.width} × {dimensions.height} px</span><span>{layerCount} {layerCount === 1 ? 'layer' : 'layers'}</span></span>
      <span role="status"><strong>{toolName}</strong> {instruction}</span>
      <span>{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>
    </footer>
    {saveDialog && <MarkupSavedDialog onContinue={onContinue} onBack={onBack} />}
  </div>
}

function MarkupSavedDialog({ onContinue, onBack }) {
  const dialogRef = useRef(null)
  useEffect(() => {
    const dialog = dialogRef.current
    dialog.showModal()
    return () => dialog.close()
  }, [])

  return <dialog ref={dialogRef} className="sb-markup-save-dialog" aria-labelledby="sb-markup-saved-title" onCancel={event => { event.preventDefault(); onContinue() }}>
    <h2 id="sb-markup-saved-title">Markup saved</h2>
    <div className="sb-markup-dialog-actions">
      <button type="button" autoFocus onClick={onContinue}>Continue Edit</button>
      <button type="button" className="primary" onClick={onBack}>Back to Builder</button>
    </div>
  </dialog>
}
