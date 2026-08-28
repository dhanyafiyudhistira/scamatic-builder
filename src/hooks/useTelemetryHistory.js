import { useEffect, useRef, useState } from 'react'

// Mixer-unit analog telemetry (Sistem2):
//   Level_mix              — MW101, mixer tank level
//   QI_102                 — MW300, quality indicator
//   Simulasi_OpeningV104   — MW200, simulated analog opening of V104
const TREND_TAGS  = ['Level_mix', 'QI_102', 'Simulasi_OpeningV104']
const MAX_POINTS  = 300          // rolling in-memory window
const PUSH_EVERY  = 30_000       // push to MongoDB every 30 s

function nowLabel() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false })
}

/**
 * Builds a rolling time-series history from live ThingsBoard telemetry
 * and persists it to the backend MongoDB in batches.
 *
 * Returns:
 *   history  — array of { timestamp, time, Level_mix, QI_102, Simulasi_OpeningV104 }
 *   loadHistory(minutes) — fetch historical rows from MongoDB
 */
export function useTelemetryHistory(telemetry, projectId = import.meta.env.VITE_LEGACY_PROJECT_ID || '') {
  const [history, setHistory]   = useState([])
  const prevRef                 = useRef({})
  const pendingRef              = useRef([])   // unsaved entries awaiting push
  const timerRef                = useRef(null)

  /* ── Append new point whenever a tracked analog changes ───────────── */
  useEffect(() => {
    const hasData = TREND_TAGS.some(t => telemetry[t] !== undefined)
    if (!hasData) return

    const changed = TREND_TAGS.some(t => telemetry[t] !== prevRef.current[t])
    if (!changed) return

    prevRef.current = { ...prevRef.current, ...telemetry }

    const ts = Date.now()
    const point = {
      timestamp:            ts,
      time:                 nowLabel(),
      Level_mix:            telemetry.Level_mix             ?? null,
      QI_102:               telemetry.QI_102                ?? null,
      Simulasi_OpeningV104: telemetry.Simulasi_OpeningV104  ?? null,
    }

    setHistory(prev => {
      const next = [...prev, point]
      return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next
    })

    // Stage for backend push
    TREND_TAGS.forEach(tag => {
      if (telemetry[tag] !== undefined) {
        pendingRef.current.push({ tag, value: telemetry[tag], timestamp: ts })
      }
    })
  }, [telemetry])

  /* ── Batch-push pending entries to MongoDB every 30 s ─────────────── */
  useEffect(() => {
    timerRef.current = setInterval(() => {
      const entries = pendingRef.current.splice(0)
      if (entries.length === 0 || !projectId) return
      fetch('/api/telemetry', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': readCookie('scada_csrf') },
        body:    JSON.stringify({ projectId, entries })
      }).catch(() => {})   // fire-and-forget; backend unavailability must not break HMI
    }, PUSH_EVERY)

    return () => clearInterval(timerRef.current)
  }, [projectId])

  /* ── Load historical data from MongoDB ────────────────────────────── */
  const loadHistory = async (minutes = 60) => {
    try {
      if (!projectId) return
      const tags = TREND_TAGS.join(',')
      const query = new URLSearchParams({ projectId, tags, minutes: String(minutes), limit: '400' })
      const res  = await fetch(`/api/telemetry?${query}`)
      if (!res.ok) return
      const rows = await res.json()
      if (rows.length > 0) setHistory(rows)
    } catch (_) {}
  }

  return { history, loadHistory }
}

function readCookie(name) {
  const prefix = `${name}=`
  const value = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith(prefix))
  if (!value) return ''
  try { return decodeURIComponent(value.slice(prefix.length)) } catch { return '' }
}
