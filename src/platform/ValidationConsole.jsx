import { useEffect, useMemo, useRef, useState } from 'react'
import { validationConsoleReport, validationDiagnostics, validationSummary } from '../../shared/validation-diagnostics.js'

export function ValidationConsole({ open, minimized, schema, issues, origin = 'Live draft validation', onMinimize, onClose, onLocate }) {
  const windowRef = useRef(null)
  const dragCleanupRef = useRef(null)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [copyState, setCopyState] = useState('idle')
  const [position, setPosition] = useState(null)
  const diagnostics = useMemo(() => validationDiagnostics(schema, issues), [schema, issues])
  const summary = useMemo(() => validationSummary(diagnostics), [diagnostics])
  const filtered = useMemo(() => diagnostics.filter(diagnostic => {
    const matchesFilter = filter === 'all' || diagnostic.severity === filter
    const haystack = `${diagnostic.code} ${diagnostic.message} ${diagnostic.path} ${diagnostic.sourceLabel} ${diagnostic.currentValue} ${diagnostic.hint}`.toLowerCase()
    return matchesFilter && (!query.trim() || haystack.includes(query.trim().toLowerCase()))
  }), [diagnostics, filter, query])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = event => {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, onClose])

  useEffect(() => () => dragCleanupRef.current?.(), [])
  useEffect(() => {
    if (!open) {
      setQuery('')
      setFilter('all')
      setCopyState('idle')
    }
  }, [open])

  if (!open) return null

  const copyReport = async () => {
    const report = validationConsoleReport({ projectName: schema?.project?.name, origin, diagnostics })
    try {
      await globalThis.navigator?.clipboard?.writeText(report)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 1800)
  }

  const startDrag = event => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button, input'))) return
    const windowElement = windowRef.current
    if (!windowElement) return
    event.preventDefault()
    dragCleanupRef.current?.()
    const bounds = windowElement.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const originX = bounds.left
    const originY = bounds.top
    const move = moveEvent => {
      const width = windowElement.offsetWidth
      const height = windowElement.offsetHeight
      setPosition({
        x: Math.max(8, Math.min(window.innerWidth - width - 8, originX + moveEvent.clientX - startX)),
        y: Math.max(8, Math.min(window.innerHeight - Math.min(height, 54) - 8, originY + moveEvent.clientY - startY)),
      })
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      dragCleanupRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    dragCleanupRef.current = cleanup
  }

  const style = position ? { left: `${position.x}px`, top: `${position.y}px`, right: 'auto', bottom: 'auto' } : undefined
  return (
    <section
      className={`sb-validation-console ${minimized ? 'is-minimized' : ''}`}
      style={style}
      ref={windowRef}
      role="dialog"
      aria-modal="false"
      aria-label="Project validation console"
    >
      <header className="sb-validation-console-header" onPointerDown={startDrag}>
        <div className="sb-validation-console-title">
          <strong>PROJECT VALIDATION CONSOLE</strong>
        </div>
        <div className="sb-validation-console-window-actions">
          <button type="button" onClick={onMinimize} aria-label={minimized ? 'Restore validation console' : 'Minimize validation console'} title={minimized ? 'Restore' : 'Minimize'}>{minimized ? '□' : '—'}</button>
          <button type="button" onClick={onClose} aria-label="Close validation console" title="Close">×</button>
        </div>
      </header>

      {!minimized && <>
        <div className="sb-validation-console-summary" role="status">
          <span><b>{summary.errors}</b> Errors</span>
          <span><b>{summary.warnings}</b> Warnings</span>
          <span><b>{summary.total}</b> Total</span>
          <small>{origin.toLowerCase().includes('server') ? 'Captured from the server validation response.' : 'Validation updates with the current project draft.'}</small>
        </div>

        <div className="sb-validation-console-toolbar">
          <label className="sb-validation-console-search"><span>Search diagnostics</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Code, component, Tag, or path…" /></label>
          <div className="sb-validation-console-filters" aria-label="Diagnostic severity filter">
            <FilterButton label="All" value="all" current={filter} count={summary.total} onChange={setFilter} />
            <FilterButton label="Errors" value="error" current={filter} count={summary.errors} onChange={setFilter} />
            <FilterButton label="Warnings" value="warning" current={filter} count={summary.warnings} onChange={setFilter} />
          </div>
          <button type="button" className="sb-validation-console-copy" onClick={copyReport}>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy report'}</button>
        </div>

        <div className="sb-validation-console-output" tabIndex="0">
          {diagnostics.length === 0 && <div className="sb-validation-console-pass"><span>✓</span><strong>No validation issues</strong><p>The current project schema is ready to publish.</p></div>}
          {diagnostics.length > 0 && filtered.length === 0 && <div className="sb-validation-console-empty"><strong>No matching diagnostics</strong><p>Adjust the search text or severity filter.</p></div>}
          {filtered.map(diagnostic => (
            <article className={`sb-validation-diagnostic ${diagnostic.severity}`} key={diagnostic.id}>
              <div className="sb-validation-diagnostic-main">
                <header>
                  <span className="sb-validation-diagnostic-severity">{diagnostic.severity}</span>
                  <code>{diagnostic.code}</code>
                  {diagnostic.sourceKind === 'component' && diagnostic.sourceId && <button type="button" onClick={() => onLocate?.(diagnostic)}>Locate component</button>}
                </header>
                <strong className="sb-validation-diagnostic-source">{diagnostic.sourceLabel}</strong>
                <p>{diagnostic.message}</p>
                <dl>
                  {diagnostic.path && <div><dt>Path</dt><dd><code>{diagnostic.path}</code></dd></div>}
                  <div><dt>Field</dt><dd>{diagnostic.field}</dd></div>
                  <div><dt>Current</dt><dd><code>{diagnostic.currentValue}</code></dd></div>
                  {diagnostic.relatedPaths.map(relatedPath => <div key={relatedPath}><dt>Related</dt><dd><code>{relatedPath}</code></dd></div>)}
                  <div className="sb-validation-diagnostic-fix"><dt>Suggested fix</dt><dd>{diagnostic.hint}</dd></div>
                </dl>
              </div>
            </article>
          ))}
        </div>
      </>}
    </section>
  )
}

function FilterButton({ label, value, current, count, onChange }) {
  return <button type="button" className={current === value ? 'is-active' : ''} aria-pressed={current === value} onClick={() => onChange(value)}>{label}<span>{count}</span></button>
}
