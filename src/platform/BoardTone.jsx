import { useEffect, useState } from 'react'

export const BOARD_TONE_STORAGE_KEY = 'scamatic.board-tone'
export const LEGACY_BOARD_TONE_STORAGE_KEY = 'scamatic.builder.board-tone'
export const BOARD_TONES = ['dark', 'light']

export function normalizeBoardTone(value) {
  return BOARD_TONES.includes(value) ? value : 'dark'
}

export function readBoardTone(storage) {
  try {
    const target = storage || globalThis.localStorage
    return normalizeBoardTone(target?.getItem(BOARD_TONE_STORAGE_KEY) || target?.getItem(LEGACY_BOARD_TONE_STORAGE_KEY))
  } catch {
    return 'dark'
  }
}

export function useBoardTone() {
  const [boardTone, setBoardTone] = useState(readBoardTone)

  useEffect(() => {
    try { globalThis.localStorage?.setItem(BOARD_TONE_STORAGE_KEY, boardTone) } catch { /* Storage can be unavailable in private contexts. */ }
  }, [boardTone])

  return [boardTone, setBoardTone]
}

export function BoardToneToggle({ value, onChange, compact = false }) {
  const tone = normalizeBoardTone(value)
  const next = tone === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className={`sb-board-tone-toggle is-${tone} ${compact ? 'is-compact' : ''}`}
      aria-label={`Board background: ${tone}. Switch to ${next}.`}
      aria-pressed={tone === 'light'}
      title={`Switch board to ${next} mode`}
      onClick={() => onChange(next)}
    >
      <span className="sb-board-tone-icon" aria-hidden="true">{tone === 'dark' ? '☾' : '☀'}</span>
      {!compact && <>Board: {tone === 'dark' ? 'Dark' : 'Light'}</>}
    </button>
  )
}
