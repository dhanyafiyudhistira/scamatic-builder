import { useEffect, useId, useRef, useState } from 'react'

export function InfoPopover({ label, title = label, align = 'start', className = '', surfaceRole = 'note', dismissOnAction = false, children }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const close = event => {
      if (event.type === 'keydown') {
        if (event.key !== 'Escape') return
        setOpen(false)
        triggerRef.current?.focus()
        return
      }
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className={`sb-info-popover ${className}`.trim()} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="sb-info-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup={surfaceRole === 'dialog' ? 'dialog' : undefined}
        title={title}
        onClick={() => setOpen(value => !value)}
      >
        <span aria-hidden="true">i</span>
      </button>
      {open && <div
        id={panelId}
        className={`sb-info-surface is-${align}`}
        role={surfaceRole}
        aria-label={surfaceRole === 'dialog' ? label : undefined}
        onClick={dismissOnAction ? event => {
          if (event.target.closest?.('button, a')) setOpen(false)
        } : undefined}
      >{children}</div>}
    </div>
  )
}

export function InfoPopoverIntro({ children }) {
  return <p className="sb-info-intro">{children}</p>
}

export function InfoPopoverSection({ title, children }) {
  return <section className="sb-info-section"><strong>{title}</strong><div>{children}</div></section>
}
