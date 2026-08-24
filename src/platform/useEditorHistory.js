import { useCallback, useRef, useState } from 'react'

export function useEditorHistory(initialValue = null, limit = 100) {
  const [state, setState] = useState({ past: [], present: initialValue, future: [] })
  const transactionRef = useRef(null)
  const presentRef = useRef(initialValue)

  const replace = useCallback(value => {
    transactionRef.current = null
    presentRef.current = value
    setState({ past: [], present: value, future: [] })
  }, [])

  const commit = useCallback(updater => {
    setState(previous => {
      const next = typeof updater === 'function' ? updater(previous.present) : updater
      if (next === previous.present) return previous
      presentRef.current = next
      return { past: [...previous.past, previous.present].slice(-limit), present: next, future: [] }
    })
  }, [limit])

  const mutate = useCallback(updater => {
    setState(previous => {
      const next = typeof updater === 'function' ? updater(previous.present) : updater
      presentRef.current = next
      return next === previous.present ? previous : { ...previous, present: next }
    })
  }, [])

  const beginTransaction = useCallback(() => {
    if (!transactionRef.current) transactionRef.current = presentRef.current
  }, [])

  const endTransaction = useCallback(() => {
    setState(previous => {
      const before = transactionRef.current
      transactionRef.current = null
      if (!before || before === previous.present) return previous
      return { past: [...previous.past, before].slice(-limit), present: previous.present, future: [] }
    })
  }, [limit])

  const undo = useCallback(() => {
    setState(previous => {
      if (previous.past.length === 0) return previous
      const present = previous.past[previous.past.length - 1]
      presentRef.current = present
      return { past: previous.past.slice(0, -1), present, future: [previous.present, ...previous.future] }
    })
  }, [])

  const redo = useCallback(() => {
    setState(previous => {
      if (previous.future.length === 0) return previous
      const [present, ...future] = previous.future
      presentRef.current = present
      return { past: [...previous.past, previous.present].slice(-limit), present, future }
    })
  }, [limit])

  return {
    value: state.present,
    replace,
    commit,
    mutate,
    beginTransaction,
    endTransaction,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  }
}
