import { useEffect, useState } from 'react'

export const THEME_TONE_STORAGE_KEY = 'scamatic.theme-tone'
export const THEME_TONES = ['cyan', 'grey']

export function normalizeThemeTone(value) {
  return THEME_TONES.includes(value) ? value : 'cyan'
}

export function initializeThemeTone() {
  let stored = 'cyan'
  try { stored = localStorage.getItem(THEME_TONE_STORAGE_KEY) || 'cyan' } catch { /* storage may be unavailable */ }
  const tone = normalizeThemeTone(stored)
  if (typeof document !== 'undefined') document.documentElement.dataset.themeTone = tone
  return tone
}

export function useThemeTone() {
  const [tone, setTone] = useState(initializeThemeTone)

  useEffect(() => {
    const sync = event => setTone(normalizeThemeTone(event.detail))
    window.addEventListener('scamatic:theme-tone', sync)
    return () => window.removeEventListener('scamatic:theme-tone', sync)
  }, [])

  const setThemeTone = value => {
    const next = normalizeThemeTone(typeof value === 'function' ? value(tone) : value)
    document.documentElement.dataset.themeTone = next
    try { localStorage.setItem(THEME_TONE_STORAGE_KEY, next) } catch { /* keep in-memory theme */ }
    setTone(next)
    window.dispatchEvent(new CustomEvent('scamatic:theme-tone', { detail: next }))
  }

  return [tone, setThemeTone]
}

export function ThemeToneToggle({ compact = false }) {
  const [tone, setThemeTone] = useThemeTone()
  const toggle = () => setThemeTone(tone === 'cyan' ? 'grey' : 'cyan')
  const nextLabel = tone === 'cyan' ? 'Grey' : 'Cyan'
  return (
    <button type="button" className={`sb-theme-tone ${compact ? 'is-compact' : ''}`} onClick={toggle} aria-label={`Switch theme tone to ${nextLabel}`} title={`Theme tone: ${tone === 'cyan' ? 'Cyan' : 'Grey'} · switch to ${nextLabel}`}>
      {!compact && <span>Tone</span>}
      <strong>{tone === 'cyan' ? 'Cyan' : 'Grey'}</strong>
    </button>
  )
}
