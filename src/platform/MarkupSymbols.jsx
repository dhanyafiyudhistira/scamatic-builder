import catalog from '../../builder-egui/assets/grindstone/catalog.json'

// The Canvas Lab export has the same arc finish used in the prototype.
export const grindstoneSymbols = catalog.symbols.map(({ generator, label, stretch, asset }) => ({
  id: generator,
  label,
  stretch: Boolean(stretch),
  width: asset.metadata.width,
  height: asset.metadata.height,
  src: `data:image/svg+xml,${encodeURIComponent(asset.content)}`,
}))
const byId = new Map(grindstoneSymbols.map(symbol => [symbol.id, symbol]))

export function GrindstoneSymbol({ symbolId, opacity }) {
  const symbol = byId.get(symbolId)
  return symbol && <img className="sb-markup-symbol" src={symbol.src} alt="" draggable={false} style={{ opacity, objectFit: symbol.stretch ? 'fill' : 'contain' }} />
}

export function GrindstoneComponentList({ onAdd }) {
  return <div className="sb-component-library sb-industrial-library" role="group" aria-label="Grindstone symbols">
    {grindstoneSymbols.map(symbol => <button key={symbol.id} type="button" className="sb-library-item" onClick={() => onAdd(symbol)}>
      <img src={symbol.src} alt="" draggable={false} />
      <strong>{symbol.label}</strong>
    </button>)}
  </div>
}
