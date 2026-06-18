import { useCallback, useEffect, useState } from 'react'

const API = '/api'   // proxied through Vite → localhost:3001

/**
 * Loads ThingsBoard connection settings for a given mode from MongoDB.
 * Re-fetches whenever `mode` changes. Provides saveSettings() to persist them back.
 */
export function useSettings(mode = 'default') {
  const [savedSettings, setSavedSettings] = useState(null)   // null = not yet loaded
  const [saving,        setSaving]         = useState(false)
  const [dbConnected,   setDbConnected]    = useState(false)  // backend reachable?

  // Load whenever mode changes
  useEffect(() => {
    setSavedSettings(null)
    fetch(`${API}/settings?mode=${encodeURIComponent(mode)}`)
      .then(r => { setDbConnected(r.ok); return r.json() })
      .then(data => {
        if (data && (data.serverUrl || data.deviceId || data.token)) {
          setSavedSettings(data)
        } else {
          setSavedSettings({ serverUrl: '', deviceId: '', token: '' })
        }
      })
      .catch(() => setDbConnected(false))
  }, [mode])

  const saveSettings = useCallback(async ({ serverUrl, deviceId, token }) => {
    setSaving(true)
    try {
      const res = await fetch(`${API}/settings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode, serverUrl, deviceId, token })
      })
      if (res.ok) {
        setSavedSettings({ serverUrl, deviceId, token })
        setDbConnected(true)
        return true
      }
    } catch (e) {
      console.warn('[useSettings] Save failed:', e.message)
    } finally {
      setSaving(false)
    }
    return false
  }, [mode])

  return { savedSettings, saveSettings, saving, dbConnected }
}
