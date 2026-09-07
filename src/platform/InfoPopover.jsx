import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function InfoPopover({ label, title = label, align = 'start', className = '', surfaceRole = 'note', dismissOnAction = false, children }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const surfaceRef = useRef(null)
  const panelId = useId()
  const [surfacePosition, setSurfacePosition] = useState(null)

  const placeSurface = useCallback(() => {
    const trigger = triggerRef.current
    const surface = surfaceRef.current
    if (!trigger || !surface) return
    const triggerRect = trigger.getBoundingClientRect()
    const surfaceRect = surface.getBoundingClientRect()
    const margin = 12
    const gap = 8
    const preferredLeft = align === 'end' ? triggerRect.right - surfaceRect.width : triggerRect.left
    const maximumLeft = Math.max(margin, window.innerWidth - surfaceRect.width - margin)
    const left = Math.min(Math.max(preferredLeft, margin), maximumLeft)
    const below = triggerRect.bottom + gap
    const above = triggerRect.top - surfaceRect.height - gap
    const maximumTop = Math.max(margin, window.innerHeight - surfaceRect.height - margin)
    const top = below + surfaceRect.height > window.innerHeight - margin && above >= margin
      ? above
      : Math.min(Math.max(below, margin), maximumTop)
    setSurfacePosition(previous => previous?.left === left && previous?.top === top ? previous : { left, top })
  }, [align])

  useLayoutEffect(() => {
    if (!open) return
    placeSurface()
    window.addEventListener('resize', placeSurface)
    window.addEventListener('scroll', placeSurface, true)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(placeSurface) : null
    if (observer) {
      observer.observe(triggerRef.current)
      observer.observe(surfaceRef.current)
    }
    return () => {
      window.removeEventListener('resize', placeSurface)
      window.removeEventListener('scroll', placeSurface, true)
      observer?.disconnect()
    }
  }, [open, placeSurface])

  useEffect(() => {
    if (!open) return
    const close = event => {
      if (event.type === 'keydown') {
        if (event.key !== 'Escape') return
        setOpen(false)
        setSurfacePosition(null)
        triggerRef.current?.focus()
        return
      }
      if (!rootRef.current?.contains(event.target) && !surfaceRef.current?.contains(event.target)) {
        setOpen(false)
        setSurfacePosition(null)
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const surface = open && <div
    ref={surfaceRef}
    id={panelId}
    className={`sb-info-surface is-${align}`}
    role={surfaceRole}
    aria-label={surfaceRole === 'dialog' ? label : undefined}
    style={{
      left: surfacePosition?.left ?? 0,
      top: surfacePosition?.top ?? 0,
      visibility: surfacePosition ? 'visible' : 'hidden',
    }}
    onClick={event => {
      event.stopPropagation()
      if (dismissOnAction && event.target.closest?.('button, a')) {
        setOpen(false)
        setSurfacePosition(null)
      }
    }}
  >{children}</div>

  return <>
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
        onClick={() => setOpen(value => {
          if (value) setSurfacePosition(null)
          return !value
        })}
      >
        <span aria-hidden="true">i</span>
      </button>
    </div>
    {surface && typeof document !== 'undefined' && createPortal(<div className={`sb-info-portal ${className}`.trim()}>{surface}</div>, document.body)}
  </>
}

export function InfoPopoverIntro({ children }) {
  return <p className="sb-info-intro">{children}</p>
}

export function InfoPopoverSection({ title, children }) {
  return <section className="sb-info-section"><strong>{title}</strong><div>{children}</div></section>
}
