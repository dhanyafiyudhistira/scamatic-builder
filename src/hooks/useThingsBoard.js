import { useCallback, useEffect, useRef, useState } from 'react'

// Sistem2 (mixer unit) — tags published by Node-RED "Format Telemetry" function.
// See deck-user.md: Valve_104/105/106 (digital), Motor_101 (digital),
// Simulasi_OpeningV104 (analog %), Level_mix (analog), QI_102 (analog).
const TELEMETRY_KEYS = 'Valve_104,Valve_105,Valve_106,Motor_101,Simulasi_OpeningV104,Level_mix,QI_102'

export function useThingsBoard(config) {
  const { url, deviceId, token } = config || {}
  const [telemetry, setTelemetry] = useState({})
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)
  const cmdIdRef = useRef(1)

  useEffect(() => {
    if (!url || !deviceId || !token) return

    // Convert http(s) → ws(s)
    const wsBase = url.replace(/^https/, 'wss').replace(/^http/, 'ws')
    const wsUrl = `${wsBase}/api/ws/plugins/telemetry?token=${token}`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      // ThingsBoard WS API: tsSubCmds for timeseries, not "cmds"
      ws.send(JSON.stringify({
        tsSubCmds: [{
          entityType: 'DEVICE',
          entityId: deviceId,
          scope: 'LATEST_TELEMETRY',
          cmdId: cmdIdRef.current++
        }],
        historyCmds: [],
        attrSubCmds: []
      }))
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.errorCode && msg.errorCode !== 0) {
          console.warn('[TB] Subscription error:', msg.errorCode, msg.errorMsg)
          return
        }
        // Shape: { subscriptionId, data: { key: [[ts, val], ...] } }
        const payload = msg.data
        if (!payload || typeof payload !== 'object') return
        const updates = {}
        Object.entries(payload).forEach(([key, entries]) => {
          if (!Array.isArray(entries) || entries.length === 0) return
          const raw = entries[entries.length - 1][1]
          // Booleans arrive as strings "true"/"false" from TB
          updates[key] = raw === 'true' ? true : raw === 'false' ? false : Number(raw)
        })
        if (Object.keys(updates).length > 0) {
          setTelemetry(prev => ({ ...prev, ...updates }))
        }
      } catch (e) {
        console.warn('[TB] WS parse error:', e)
      }
    }

    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [url, deviceId, token])

  const sendRpc = useCallback(async (method, params) => {
    if (!url || !deviceId || !token) return false
    try {
      const res = await fetch(`${url}/api/plugins/rpc/oneway/${deviceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ method, params, timeout: 5000, retries: 0 })
      })
      if (!res.ok) {
        console.warn('[TB] RPC response:', res.status, method)
        return false
      }
      return true
    } catch (e) {
      console.error('[TB] RPC error:', e)
      return false
    }
  }, [url, deviceId, token])

  return { telemetry, connected, sendRpc }
}
