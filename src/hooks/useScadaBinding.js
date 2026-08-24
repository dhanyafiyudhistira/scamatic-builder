import { useEffect } from 'react'

export function useScadaBinding(containerRef, telemetry, sendRpc, bindingKey) {
  // Bind toggle elements → RPC on click
  // Click ONLY fires the RPC — DOM state is driven exclusively by telemetry.
  // A "pending" visual (dimmed + pulsing lamp) gives instant feedback while
  // the device round-trip completes.
  // bindingKey: bump (e.g. mode change) when innerHTML is replaced so handlers re-attach.
  useEffect(() => {
    if (!containerRef.current) return
    const toggles = containerRef.current.querySelectorAll('[data-scada-type="toggle"]')
    const handlers = []

    toggles.forEach(el => {
      const method = el.dataset.rpcMethod
      if (!method || el.dataset.readonly === 'true') return  // read-only — no RPC binding

      const handler = async () => {
        if (el.dataset.pending === 'true') return   // ignore rapid double-clicks
        const current = el.dataset.state === 'true'
        const next = !current

        // Pending state: dim the card until telemetry confirms or RPC fails
        el.dataset.pending = 'true'
        el.style.opacity = '0.6'
        const lamp = el.querySelector('[data-scada-type="lamp"]')
        if (lamp) lamp.style.animation = 'scada-pulse 0.6s ease-in-out infinite alternate'

        const ok = await sendRpc(method, next)

        if (!ok) {
          // RPC failed — clear pending immediately and flash the card border red
          el.dataset.pending = ''
          el.style.opacity = ''
          if (lamp) lamp.style.animation = ''
          el.style.outline = '1.5px solid #ef4444'
          setTimeout(() => { el.style.outline = '' }, 1200)
        }
      }

      el.addEventListener('click', handler)
      handlers.push({ el, handler })
    })

    return () => handlers.forEach(({ el, handler }) => el.removeEventListener('click', handler))
  }, [containerRef, sendRpc, bindingKey])

  // Apply telemetry → DOM  (authoritative — clears pending on arrival)
  useEffect(() => {
    if (!containerRef.current) return

    Object.entries(telemetry).forEach(([tag, value]) => {
      // Toggles
      containerRef.current.querySelectorAll(`[data-scada-type="toggle"][data-tag="${tag}"]`)
        .forEach(el => {
          // Clear pending state
          el.dataset.pending = ''
          el.style.opacity = ''

          el.dataset.state = String(value)
          el.style.color = value
            ? (el.dataset.onColor || '#22c55e')
            : (el.dataset.offColor || '#475569')

          const lbl = el.querySelector('[data-state-label]')
          if (lbl) {
            lbl.textContent = value ? 'ON' : 'OFF'
            lbl.setAttribute('fill', value ? '#22c55e' : '#64748b')
          }
        })

      // Status indicators (small chip above valve label)
      containerRef.current.querySelectorAll(`[data-scada-type="indicator"][data-tag="${tag}"]`)
        .forEach(el => {
          el.dataset.state = String(value)
          el.setAttribute('fill', value
            ? (el.dataset.onFill || '#22c55e')
            : (el.dataset.offFill || '#94a3b8'))
        })

      // Lamps
      containerRef.current.querySelectorAll(`[data-scada-type="lamp"][data-tag="${tag}"]`)
        .forEach(el => {
          el.style.animation = ''   // clear pulse

          el.dataset.state = String(value)
          el.setAttribute('fill', value
            ? (el.dataset.onFill || '#22c55e')
            : (el.dataset.offFill || '#1e293b'))
          if (el.dataset.onGlow === 'true') {
            const glowColor = el.dataset.onFill || '#22c55e'
            el.style.filter = value ? `drop-shadow(0 0 8px ${glowColor})` : 'none'
          }
        })

      // Values
      containerRef.current.querySelectorAll(`[data-scada-type="value"][data-tag="${tag}"]`)
        .forEach(el => {
          const decimals = parseInt(el.dataset.decimals || '2', 10)
          const unit = el.dataset.unit || ''
          el.textContent = `${Number(value).toFixed(decimals)} ${unit}`

          const high = parseFloat(el.dataset.alarmHigh)
          const low = parseFloat(el.dataset.alarmLow)
          if (!isNaN(high) && value >= high)     el.setAttribute('fill', '#ef4444')
          else if (!isNaN(low) && value <= low)  el.setAttribute('fill', '#f59e0b')
          else                                   el.setAttribute('fill', '#22d3ee')
        })
    })
  }, [containerRef, telemetry])
}
