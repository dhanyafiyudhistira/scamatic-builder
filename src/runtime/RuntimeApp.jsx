import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RuntimeCanvas } from '../platform/RuntimeCanvas.jsx'
import { apiRequest, login } from '../platform/api.js'
import { ThemeToneToggle, useThemeTone } from '../platform/ThemeTone.jsx'
import { useBoardTone } from '../platform/BoardTone.jsx'
import { appendRuntimeHistory, seedRuntimeHistory } from '../../shared/runtime-history.js'
import { commandCompletionBudgetMs, commandResultCanReplace, commandResultRetentionMs, commandStatusPresentation, commandStatusRank, isPendingCommandStatus } from '../../shared/command-lifecycle.js'
import { runtimeProfileMetadata } from '../../shared/runtime-profile.js'
import { advanceSimulationValue, applySimulationRpc, simulationTelemetryBaseline, simulationTelemetryDelta } from '../../shared/simulation-bridge.js'
import { initialSimulationBridgeHealth, simulationCommandConnectionAvailable, simulationStandbyRetryDelay, updateSimulationBridgeHealth, updateSimulationBridgeLease } from '../../shared/simulation-health.js'
import { createSimulationTelemetryQueue } from '../../shared/simulation-telemetry-queue.js'
import { nextRuntimeResponderIdentity } from '../../shared/runtime-responder.js'

export default function RuntimeApp({ slug }) {
  const [session, setSession] = useState({ loading: true, user: null })
  const [runtime, setRuntime] = useState(null)
  const [runtimeSession, setRuntimeSession] = useState(null)
  const [state, setState] = useState('checking-access')
  const [lockedProjectId, setLockedProjectId] = useState(null)
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0)
  const [showRuntimeReady, setShowRuntimeReady] = useState(false)
  const [error, setError] = useState('')
  const [values, setValues] = useState({})
  const [qualities, setQualities] = useState({})
  const [histories, setHistories] = useState({})
  const [commandNotice, setCommandNotice] = useState(null)
  const [commandResults, setCommandResults] = useState({})
  const [simulationBridgeHealth, setSimulationBridgeHealth] = useState(() => initialSimulationBridgeHealth())
  const commandTimersRef = useRef(new Map())
  const commandResultsRef = useRef({})
  const commandPushResultsRef = useRef(new Map())
  const commandPushWaitersRef = useRef(new Map())
  const simulationSequenceRunsRef = useRef(new Map())
  const valuesRef = useRef({})
  const processedRpcRef = useRef(new Set())
  const pendingRpcRef = useRef(new Map())
  const publishedSimulationValuesRef = useRef({})
  const simulationTelemetryFlushRef = useRef(null)
  const simulationTargetsRef = useRef({})
  const simulationLeaseActiveRef = useRef(true)
  const simulationHeartbeatDueRef = useRef(true)
  const simulationHealthRef = useRef(initialSimulationBridgeHealth())
  const previousRuntimeStateRef = useRef(state)
  const [boardTone, setBoardTone] = useBoardTone()
  const profile = runtime?.profile || runtimeSession?.profile || runtimeProfileMetadata(runtime?.schema)

  useEffect(() => { valuesRef.current = values }, [values])

  const rememberCommandResult = useCallback((component, result) => {
    const current = commandResultsRef.current[component.id]
    if (!commandResultCanReplace(current, result)) return current
    const presentation = commandStatusPresentation(result.status)
    const entry = {
      ...result,
      componentId: component.id,
      componentName: component.properties?.label || component.name || component.id,
      status: result.status || 'unknown',
      presentation,
      observedAt: new Date().toISOString(),
    }
    const previousTimer = commandTimersRef.current.get(component.id)
    if (previousTimer) window.clearTimeout(previousTimer)
    commandTimersRef.current.delete(component.id)
    commandResultsRef.current = { ...commandResultsRef.current, [component.id]: entry }
    setCommandResults(commandResultsRef.current)
    setCommandNotice(entry)
    if (!isPendingCommandStatus(entry.status)) {
      const timer = window.setTimeout(() => {
        if (commandResultsRef.current[component.id]?.requestId === entry.requestId) {
          const next = { ...commandResultsRef.current }
          delete next[component.id]
          commandResultsRef.current = next
          setCommandResults(next)
        }
        setCommandNotice(previous => previous?.requestId === entry.requestId ? null : previous)
        commandTimersRef.current.delete(component.id)
      }, commandResultRetentionMs(entry.status))
      commandTimersRef.current.set(component.id, timer)
    }
    return entry
  }, [])

  const receiveCommandPush = useCallback(result => {
    if (!result?.requestId || !result?.componentId) return
    const cached = commandPushResultsRef.current.get(result.requestId)
    if (!commandResultCanReplace(cached, result)) return
    commandPushResultsRef.current.delete(result.requestId)
    commandPushResultsRef.current.set(result.requestId, result)
    if (commandPushResultsRef.current.size > 500) commandPushResultsRef.current.delete(commandPushResultsRef.current.keys().next().value)
    const waiters = commandPushWaitersRef.current.get(result.requestId)
    if (waiters) {
      commandPushWaitersRef.current.delete(result.requestId)
      for (const waiter of waiters) {
        window.clearTimeout(waiter.timer)
        waiter.resolve(result)
      }
    }
    const component = runtime?.schema?.components?.find(item => item.id === result.componentId)
    if (component) rememberCommandResult(component, result)
  }, [rememberCommandResult, runtime?.schema?.components])

  const waitForCommandPush = useCallback((requestId, afterStatus, timeoutMs) => {
    const cached = commandPushResultsRef.current.get(requestId)
    if (cached && commandStatusRank(cached.status) > commandStatusRank(afterStatus)) return Promise.resolve(cached)
    return new Promise(resolve => {
      const waiters = commandPushWaitersRef.current.get(requestId) || new Set()
      const waiter = {
        resolve,
        timer: window.setTimeout(() => {
          waiters.delete(waiter)
          if (!waiters.size) commandPushWaitersRef.current.delete(requestId)
          resolve(null)
        }, Math.max(1, Number(timeoutMs) || 1)),
      }
      waiters.add(waiter)
      commandPushWaitersRef.current.set(requestId, waiters)
    })
  }, [])

  useEffect(() => {
    const previous = previousRuntimeStateRef.current
    previousRuntimeStateRef.current = state
    if (state !== 'online') {
      setShowRuntimeReady(false)
      return undefined
    }
    if (!['connecting', 'reconnecting', 'degraded', 'standby', 'synchronizing', 'disconnected'].includes(previous)) return undefined
    setShowRuntimeReady(true)
    const timer = window.setTimeout(() => setShowRuntimeReady(false), 1800)
    return () => window.clearTimeout(timer)
  }, [state])

  const commitSimulationHealth = useCallback(next => {
    simulationHealthRef.current = next
    setSimulationBridgeHealth(next)
    setState(next.status)
  }, [])

  const updateSimulationHealth = useCallback((channel, succeeded, details = {}) => {
    commitSimulationHealth(updateSimulationBridgeHealth(simulationHealthRef.current, channel, succeeded, details))
  }, [commitSimulationHealth])

  const updateSimulationLease = useCallback((active, details = {}) => {
    const wasActive = simulationLeaseActiveRef.current
    simulationLeaseActiveRef.current = active !== false
    if (!wasActive && active !== false) simulationHeartbeatDueRef.current = true
    commitSimulationHealth(updateSimulationBridgeLease(simulationHealthRef.current, active, details))
  }, [commitSimulationHealth])

  const requestSimulationTelemetryFlush = useCallback((changes, options = {}) => {
    const flush = simulationTelemetryFlushRef.current
    return typeof flush === 'function' ? flush(changes, options) : false
  }, [])

  const manageSimulationResponderLease = useCallback(async (action, { keepalive = false } = {}) => {
    const bridge = runtimeSession?.telemetry?.bridge
    if (runtimeSession?.telemetry?.mode !== 'simulation' || !bridge?.available || !runtime?.projectId || !runtimeSession?.token) return null
    const data = await apiRequest('/api/simulator', {
      method: 'POST',
      keepalive,
      headers: { 'X-Runtime-Token': runtimeSession.token },
      body: JSON.stringify({ projectId: runtime.projectId, action }),
    })
    if (action === 'takeover') updateSimulationLease(data.lease?.active !== false, data.lease || {})
    if (action === 'release' && data.released) updateSimulationLease(false)
    return data
  }, [runtime?.projectId, runtimeSession?.telemetry?.bridge, runtimeSession?.telemetry?.mode, runtimeSession?.token, updateSimulationLease])

  const createRuntimeSession = useCallback(projectId => {
    const responder = nextRuntimeResponderIdentity()
    return apiRequest('/api/runtime-session', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        responderId: responder.id,
        responderGeneration: responder.generation,
      }),
    })
  }, [])

  useEffect(() => () => {
    for (const timer of commandTimersRef.current.values()) window.clearTimeout(timer)
    commandTimersRef.current.clear()
    for (const waiters of commandPushWaitersRef.current.values()) {
      for (const waiter of waiters) {
        window.clearTimeout(waiter.timer)
        waiter.resolve(null)
      }
    }
    commandPushWaitersRef.current.clear()
    for (const run of simulationSequenceRunsRef.current.values()) run.controller.abort()
    simulationSequenceRunsRef.current.clear()
  }, [])

  useEffect(() => {
    if (runtimeSession?.telemetry?.mode !== 'simulation' || !runtimeSession?.telemetry?.bridge?.available) return undefined
    const release = () => { void manageSimulationResponderLease('release', { keepalive: true }).catch(() => {}) }
    window.addEventListener('pagehide', release)
    return () => {
      window.removeEventListener('pagehide', release)
      release()
    }
  }, [manageSimulationResponderLease, runtimeSession?.telemetry?.bridge?.available, runtimeSession?.telemetry?.mode])

  const checkSession = useCallback(async () => {
    try { const data = await apiRequest('/api/auth'); setSession({ loading: false, user: data.user }) }
    catch { setSession({ loading: false, user: null }); setState('unauthenticated') }
  }, [])
  useEffect(() => { checkSession() }, [checkSession])

  useEffect(() => {
    if (!session.user) return
    let cancelled = false
    const bootstrap = async () => {
      setState('loading-schema'); setError(''); setLockedProjectId(null)
      try {
        const data = await apiRequest(`/api/runtime?slug=${encodeURIComponent(slug)}`)
        if (cancelled) return
        setRuntime(data)
        const initialValues = Object.fromEntries(Object.entries(data.values || {}).map(([tagId, sample]) => [tagId, sample.value]))
        valuesRef.current = initialValues
        simulationTargetsRef.current = { ...(data.simulationTargets || {}) }
        setValues(initialValues)
        setQualities(Object.fromEntries(Object.entries(data.values || {}).map(([tagId, sample]) => [tagId, sample.quality || 'good'])))
        setHistories(seedRuntimeHistory(data.values || {}, data.history || {}))
        setState('connecting')
        const scoped = await createRuntimeSession(data.projectId)
        if (cancelled) return
        setRuntimeSession(scoped)
        const waitsForTransport = ['poll', 'stream', 'simulation'].includes(scoped.telemetry?.mode) || Boolean(scoped.stream?.url)
        setState(waitsForTransport ? 'connecting' : 'online')
      } catch (requestError) {
        if (!cancelled && requestError.code === 'PROJECT_LOCKED') {
          setLockedProjectId(requestError.result?.projectId || null)
          setState('project-locked')
        } else if (!cancelled) {
          setError(requestError.message)
          setState('invalid-project')
        }
      }
    }
    bootstrap()
    return () => { cancelled = true }
  }, [bootstrapAttempt, createRuntimeSession, session.user, slug])

  useEffect(() => {
    if (!runtimeSession?.stream?.url || !runtimeSession?.stream?.ticket) return
    let disposed = false
    let reconnectTimer = null
    let reconnectAttempt = 0
    const socket = new WebSocket(`${runtimeSession.stream.url}?ticket=${encodeURIComponent(runtimeSession.stream.ticket)}`)
    socket.addEventListener('open', () => setState('online'))
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'command-status') {
          receiveCommandPush(message.command)
          return
        }
        if (message.type !== 'tag-batch' || !Array.isArray(message.events)) return
        setValues(previous => {
          const next = { ...previous }
          for (const item of message.events) next[item.tagId] = item.value
          return next
        })
        setQualities(previous => {
          const next = { ...previous }
          for (const item of message.events) next[item.tagId] = item.quality
          return next
        })
        setHistories(previous => appendRuntimeHistory(previous, message.events))
      } catch { /* Ignore malformed worker frames. */ }
    })
    socket.addEventListener('close', () => {
      if (disposed) return
      setState('reconnecting')
      const reconnect = async () => {
        if (disposed) return
        try {
          const scoped = await createRuntimeSession(runtime.projectId)
          if (!disposed) {
            setRuntimeSession(scoped)
            setState('connecting')
          }
        } catch {
          if (disposed) return
          reconnectAttempt += 1
          setState('disconnected')
          const retryMs = Math.min(5000, 250 * (2 ** Math.min(reconnectAttempt, 5)))
          reconnectTimer = window.setTimeout(reconnect, retryMs)
        }
      }
      reconnectTimer = window.setTimeout(reconnect, 250)
    })
    socket.addEventListener('error', () => setState('degraded'))
    return () => { disposed = true; window.clearTimeout(reconnectTimer); socket.close() }
  }, [createRuntimeSession, receiveCommandPush, runtime?.projectId, runtimeSession?.stream?.ticket, runtimeSession?.stream?.url])

  useEffect(() => {
    if (runtimeSession?.telemetry?.mode !== 'poll' || !runtime?.projectId || !runtimeSession?.token) return
    let disposed = false
    let timer = null
    const intervalMs = Math.max(1000, Number(runtimeSession.telemetry.intervalMs) || 2000)
    const poll = async () => {
      try {
        const data = await apiRequest(`/api/runtime-telemetry?projectId=${encodeURIComponent(runtime.projectId)}`, {
          headers: { 'X-Runtime-Token': runtimeSession.token },
        })
        if (disposed) return
        const events = Array.isArray(data.events) ? data.events : []
        if (events.length) {
          setValues(previous => {
            const next = { ...previous }
            for (const item of events) next[item.tagId] = item.value
            return next
          })
          setQualities(previous => {
            const next = { ...previous }
            for (const item of events) next[item.tagId] = item.quality || 'good'
            return next
          })
          setHistories(previous => appendRuntimeHistory(previous, events))
        }
        setState(data.state === 'degraded' ? 'degraded' : 'online')
      } catch {
        if (!disposed) setState('degraded')
      } finally {
        if (!disposed) timer = window.setTimeout(poll, intervalMs)
      }
    }
    poll()
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [runtime?.projectId, runtimeSession?.telemetry?.intervalMs, runtimeSession?.telemetry?.mode, runtimeSession?.token])

  useEffect(() => {
    if (runtimeSession?.telemetry?.mode !== 'simulation' || !runtime?.schema?.tags) return
    let disposed = false
    let sequence = 0
    let previousTickAt = Date.now()
    let timer = null
    const intervalMs = Math.max(500, Number(runtimeSession.telemetry.visualIntervalMs ?? runtimeSession.telemetry.intervalMs) || 500)
    const initialHealth = initialSimulationBridgeHealth()
    simulationHealthRef.current = initialHealth
    setSimulationBridgeHealth(initialHealth)
    publishedSimulationValuesRef.current = simulationTelemetryBaseline(runtime.schema, valuesRef.current)
    simulationLeaseActiveRef.current = true
    simulationHeartbeatDueRef.current = true
    pendingRpcRef.current.clear()
    processedRpcRef.current.clear()
    setState('online')
    setQualities(Object.fromEntries(runtime.schema.tags.map(tag => [tag.id, 'good'])))
    const tagsById = new Map(runtime.schema.tags.map(tag => [tag.id, tag]))
    const rampControls = (runtime.schema.components || []).flatMap(component => {
      if (component.type !== 'tuning-slider') return []
      const targetTagId = component.properties?.feedbackTagId || component.binding?.tagId
      const tag = tagsById.get(targetTagId)
      if (!tag || tag.dataType !== 'number' || !['read', 'read-write'].includes(tag.access)) return []
      const min = Number(component.properties?.min ?? 0)
      const max = Number(component.properties?.max ?? 100)
      const configuredRate = Number(component.properties?.simulationRampPerSecond)
      const defaultRate = Math.max(.001, Math.abs(max - min) * .001)
      const legacyDefaultRate = runtime.schema.schemaVersion === '1.4.0' && configuredRate === 5
      return [{
        tag,
        targetTagId,
        ratePerSecond: Number.isFinite(configuredRate) && configuredRate > 0 && !legacyDefaultRate ? configuredRate : defaultRate,
        decimals: Math.max(0, Math.min(8, Number(component.properties?.decimals ?? 0))),
      }]
    })
    simulationTargetsRef.current = {
      ...Object.fromEntries(rampControls.map(control => [
        control.targetTagId,
        simulationTargetsRef.current[control.targetTagId] ?? Number(valuesRef.current[control.targetTagId] ?? 0),
      ])),
      ...simulationTargetsRef.current,
    }
    const tick = () => {
      const timestamp = Date.now()
      const elapsedSeconds = Math.max(.001, Math.min(2, (timestamp - previousTickAt) / 1000))
      previousTickAt = timestamp
      sequence += 1
      const events = rampControls.flatMap(control => {
        const current = Number(valuesRef.current[control.targetTagId] ?? 0)
        const target = Number(simulationTargetsRef.current[control.targetTagId] ?? current)
        if (!Number.isFinite(current) || !Number.isFinite(target) || Object.is(current, target)) return []
        const value = advanceSimulationValue(current, target, control.ratePerSecond, elapsedSeconds, Math.max(2, control.decimals))
        if (Object.is(value, current)) return []
        return [{ tagId: control.targetTagId, value, quality: 'good', sourceTimestamp: new Date(timestamp).toISOString(), sequence }]
      })
      if (events.length) {
        const nextValues = { ...valuesRef.current, ...Object.fromEntries(events.map(event => [event.tagId, event.value])) }
        valuesRef.current = nextValues
        if (!disposed) {
          setValues(nextValues)
          setHistories(previous => appendRuntimeHistory(previous, events))
        }
      }
      if (!disposed) timer = window.setTimeout(tick, intervalMs)
    }
    tick()
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [runtime?.schema, runtimeSession?.telemetry?.intervalMs, runtimeSession?.telemetry?.mode, runtimeSession?.telemetry?.visualIntervalMs])

  useEffect(() => {
    const bridge = runtimeSession?.telemetry?.bridge
    if (runtimeSession?.telemetry?.mode !== 'simulation' || !bridge?.available || !runtime?.projectId || !runtime?.schema?.tags || !runtimeSession?.token) return
    let disposed = false
    let timer = null
    let draining = false
    let lastSuccessAt = Date.now()
    const controller = new AbortController()
    const queue = createSimulationTelemetryQueue()
    const publishIntervalMs = Math.max(1000, Number(runtimeSession.telemetry.publishIntervalMs) || 1000)
    const heartbeatIntervalMs = Math.max(15_000, Number(runtimeSession.telemetry.heartbeatIntervalMs) || 20_000)
    const drain = async () => {
      if (disposed || draining || !simulationLeaseActiveRef.current) return
      draining = true
      try {
        while (!disposed && simulationLeaseActiveRef.current) {
          const job = queue.take()
          if (!job) break
          const heartbeatDue = simulationHeartbeatDueRef.current || Date.now() - lastSuccessAt >= heartbeatIntervalMs
          if (job.kind === 'heartbeat' && !heartbeatDue) {
            queue.acknowledge(job.id)
            continue
          }
          const delta = job.kind === 'heartbeat'
            ? {}
            : simulationTelemetryDelta(runtime.schema, job.values, publishedSimulationValuesRef.current)
          const heartbeat = job.kind === 'heartbeat' && !Object.keys(delta).length
          if (!Object.keys(delta).length && !heartbeat) {
            queue.acknowledge(job.id)
            continue
          }
          const timestamp = Date.now()
          try {
            await apiRequest('/api/simulator', {
              method: 'POST',
              signal: controller.signal,
              headers: { 'X-Runtime-Token': runtimeSession.token },
              body: JSON.stringify({ projectId: runtime.projectId, action: 'telemetry', timestamp, values: delta, heartbeat }),
            })
            if (disposed) return
            queue.acknowledge(job.id)
            simulationLeaseActiveRef.current = true
            simulationHeartbeatDueRef.current = false
            publishedSimulationValuesRef.current = { ...publishedSimulationValuesRef.current, ...delta }
            lastSuccessAt = Date.now()
            updateSimulationHealth('telemetry', true)
          } catch (requestError) {
            queue.retry(job.id)
            if (disposed || controller.signal.aborted) return
            if (requestError?.code === 'SIMULATION_RESPONDER_STANDBY') {
              updateSimulationLease(false, {
                retryAfterMs: requestError.result?.retryAfterMs,
                expiresAt: requestError.result?.expiresAt,
              })
            } else {
              updateSimulationHealth('telemetry', false, { errorCode: requestError?.code })
            }
            break
          }
        }
      } finally {
        draining = false
      }
    }
    const requestFlush = (changes, { preserveOrder = false } = {}) => {
      const queued = queue.enqueue(changes, { preserveOrder })
      if (!queued.accepted) {
        if (queued.reason === 'full') updateSimulationHealth('telemetry', false, { errorCode: 'SIMULATION_TELEMETRY_QUEUE_FULL' })
        return false
      }
      void drain()
      return true
    }
    simulationTelemetryFlushRef.current = requestFlush
    const publish = async () => {
      queue.enqueue(valuesRef.current)
      if (simulationHeartbeatDueRef.current || Date.now() - lastSuccessAt >= heartbeatIntervalMs) queue.enqueueHeartbeat()
      await drain()
      if (!disposed) timer = window.setTimeout(publish, publishIntervalMs)
    }
    timer = window.setTimeout(publish, publishIntervalMs)
    return () => {
      disposed = true
      controller.abort()
      window.clearTimeout(timer)
      queue.clear()
      if (simulationTelemetryFlushRef.current === requestFlush) simulationTelemetryFlushRef.current = null
    }
  }, [runtime?.projectId, runtime?.schema, runtimeSession?.telemetry?.bridge, runtimeSession?.telemetry?.heartbeatIntervalMs, runtimeSession?.telemetry?.mode, runtimeSession?.telemetry?.publishIntervalMs, runtimeSession?.token, updateSimulationHealth, updateSimulationLease])

  useEffect(() => {
    const bridge = runtimeSession?.telemetry?.bridge
    if (runtimeSession?.telemetry?.mode !== 'simulation' || !bridge?.available || !runtime?.projectId || !runtimeSession?.token) return
    let active = true
    const controller = new AbortController()
    const rememberProcessed = requestId => {
      processedRpcRef.current.add(requestId)
      if (processedRpcRef.current.size > 500) processedRpcRef.current.delete(processedRpcRef.current.values().next().value)
    }
    const sendPending = async (requestId, body) => {
      await apiRequest('/api/simulator', {
        method: 'POST',
        headers: { 'X-Runtime-Token': runtimeSession.token },
        body: JSON.stringify(body),
      })
      pendingRpcRef.current.delete(requestId)
      rememberProcessed(requestId)
      updateSimulationLease(true)
      if (body.action === 'acknowledge') {
        publishedSimulationValuesRef.current = { ...publishedSimulationValuesRef.current, ...body.values }
      }
    }
    const loop = async () => {
      while (active) {
        try {
          const pending = pendingRpcRef.current.entries().next().value
          if (pending) {
            await sendPending(pending[0], pending[1])
            if (active) updateSimulationHealth('rpc', true)
            continue
          }
          const data = await apiRequest(`/api/simulator?projectId=${encodeURIComponent(runtime.projectId)}`, {
            signal: controller.signal,
            headers: { 'X-Runtime-Token': runtimeSession.token },
          })
          const leaseActive = data.lease?.active !== false
          updateSimulationLease(leaseActive, data.lease || {})
          if (!leaseActive) {
            const retryAfterMs = simulationStandbyRetryDelay(data.lease?.retryAfterMs)
            await new Promise(resolve => window.setTimeout(resolve, retryAfterMs))
            continue
          }
          updateSimulationHealth('rpc', true)
          const request = data.request
          if (!request || !active) continue
          const requestId = String(request.id)
          if (processedRpcRef.current.has(requestId)) continue
          const result = applySimulationRpc(runtime.schema, valuesRef.current, request)
          const rpcComponent = result.ok && (runtime.schema.components || []).find(component => component.id === result.componentId)
          const rampTargetTagId = rpcComponent?.type === 'tuning-slider'
            ? rpcComponent.properties?.feedbackTagId || rpcComponent.binding?.tagId
            : null
          if (result.ok) {
            if (result.resetTagId) {
              for (const component of runtime.schema.components || []) {
                if (component.type !== 'tuning-slider') continue
                const targetTagId = component.properties?.feedbackTagId || component.binding?.tagId
                simulationTargetsRef.current[targetTagId] = Number(result.changes[targetTagId] ?? 0)
              }
            }
            if (rampTargetTagId) simulationTargetsRef.current[rampTargetTagId] = result.changes[rampTargetTagId]
            const immediateChanges = rampTargetTagId
              ? Object.fromEntries(Object.entries(result.changes).filter(([tagId]) => tagId !== rampTargetTagId))
              : result.changes
            const nextValues = { ...valuesRef.current, ...immediateChanges }
            valuesRef.current = nextValues
            setValues(nextValues)
            setQualities(previous => ({ ...previous, ...Object.fromEntries(Object.keys(immediateChanges).map(tagId => [tagId, 'good'])) }))
            if (result.resetTagId && result.resetAfterMs) {
              window.setTimeout(() => {
                const resetValues = { ...valuesRef.current, [result.resetTagId]: false }
                valuesRef.current = resetValues
                setValues(resetValues)
              }, result.resetAfterMs)
            }
          }
          const body = result.ok
            ? rampTargetTagId
              ? { projectId: runtime.projectId, action: 'respond', requestId: request.id, payload: { ...result.response, message: 'Setpoint accepted; process value is ramping.' } }
              : { projectId: runtime.projectId, action: 'acknowledge', timestamp: Date.now(), values: result.changes, requestId: request.id, payload: result.response }
            : { projectId: runtime.projectId, action: 'respond', requestId: request.id, payload: result.response }
          pendingRpcRef.current.set(requestId, body)
          await sendPending(requestId, body)
          if (active) updateSimulationHealth('rpc', true)
        } catch (requestError) {
          if (!active || controller.signal.aborted) return
          if (requestError?.code === 'SIMULATION_RESPONDER_STANDBY') {
            pendingRpcRef.current.clear()
            updateSimulationLease(false, {
              retryAfterMs: requestError.result?.retryAfterMs,
              expiresAt: requestError.result?.expiresAt,
            })
          } else {
            updateSimulationHealth('rpc', false, { errorCode: requestError?.code })
          }
          await new Promise(resolve => window.setTimeout(resolve, 2500))
        }
      }
    }
    void loop()
    return () => { active = false; controller.abort() }
  }, [runtime?.projectId, runtime?.schema, runtimeSession?.telemetry?.bridge, runtimeSession?.telemetry?.mode, runtimeSession?.token, updateSimulationHealth, updateSimulationLease])

  const cancelSimulationSequence = useCallback(operationComponentId => {
    const active = simulationSequenceRunsRef.current.get(operationComponentId)
    if (!active) return false
    active.controller.abort()
    simulationSequenceRunsRef.current.delete(operationComponentId)
    return true
  }, [])

  const beginSimulationSequence = useCallback(async (operation, enabledStepIds, operationRequestId) => {
    cancelSimulationSequence(operation.id)
    const plan = await apiRequest('/api/simulation-sequence', {
      method: 'POST',
      body: JSON.stringify({
        action: 'start',
        projectId: runtime.projectId,
        runtimeToken: runtimeSession.token,
        operationComponentId: operation.id,
        operationRequestId,
        enabledStepIds,
      }),
    })
    const controller = new AbortController()
    const activeRun = { runId: plan.runId, controller }
    simulationSequenceRunsRef.current.set(operation.id, activeRun)

    void (async () => {
      try {
        for (const step of plan.steps || []) {
          await waitForSimulationStep(step.delayMs, controller.signal)
          const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
          const result = await apiRequest('/api/simulation-sequence', {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({
              action: 'step',
              projectId: runtime.projectId,
              runtimeToken: runtimeSession.token,
              operationComponentId: operation.id,
              operationRequestId,
              enabledStepIds,
              runId: plan.runId,
              requestId,
              stepId: step.id,
            }),
          })
          if (controller.signal.aborted) return
          const changes = result.changes && typeof result.changes === 'object' ? result.changes : {}
          if (Object.keys(changes).length) {
            const nextValues = { ...valuesRef.current, ...changes }
            valuesRef.current = nextValues
            setValues(nextValues)
            setQualities(previous => ({ ...previous, ...Object.fromEntries(Object.keys(changes).map(tagId => [tagId, 'good'])) }))
            requestSimulationTelemetryFlush(changes, { preserveOrder: true })
          }
          const target = (runtime.schema.components || []).find(component => component.id === result.componentId)
          if (target) rememberCommandResult(target, result)
        }
        if (simulationSequenceRunsRef.current.get(operation.id) !== activeRun) return
        rememberCommandResult(operation, {
          ok: true,
          requestId: `${plan.runId}-complete`,
          status: 'acknowledged',
          message: `AUTO simulation sequence completed (${plan.steps?.length || 0} steps).`,
          tagId: operation.binding?.tagId,
          correlationId: null,
        })
      } catch (sequenceError) {
        if (controller.signal.aborted) return
        rememberCommandResult(operation, {
          ok: false,
          requestId: `${plan.runId}-failed`,
          status: Number(sequenceError.status) >= 400 && Number(sequenceError.status) < 500 ? 'rejected' : 'failed',
          message: sequenceError.message,
          code: sequenceError.code || 'SIMULATION_SEQUENCE_FAILED',
          tagId: operation.binding?.tagId,
          correlationId: sequenceError.correlationId || null,
        })
      } finally {
        if (simulationSequenceRunsRef.current.get(operation.id) === activeRun) simulationSequenceRunsRef.current.delete(operation.id)
      }
    })()
    return plan
  }, [cancelSimulationSequence, rememberCommandResult, requestSimulationTelemetryFlush, runtime?.projectId, runtime?.schema?.components, runtimeSession?.token])

  useEffect(() => {
    if (!runtime?.projectId || !runtimeSession?.token || !runtime?.schema?.components) return
    let cancelled = false
    const restoreRecentCommands = async () => {
      try {
        const data = await apiRequest(`/api/commands?projectId=${encodeURIComponent(runtime.projectId)}&recent=1`, {
          headers: { 'X-Runtime-Token': runtimeSession.token },
        })
        const components = new Map(runtime.schema.components.map(component => [component.id, component]))
        for (const result of [...(data.commands || [])].reverse()) {
          if (cancelled) return
          const component = components.get(result.componentId)
          if (!component) continue
          const terminalAge = result.completedAt ? Date.now() - new Date(result.completedAt).getTime() : Number.POSITIVE_INFINITY
          if (isPendingCommandStatus(result.status) || terminalAge <= commandResultRetentionMs(result.status)) rememberCommandResult(component, result)
          if (!isPendingCommandStatus(result.status)) continue
          reconcileCommandStatus({
            projectId: runtime.projectId,
            runtimeToken: runtimeSession.token,
            requestId: result.requestId,
            initialResult: result,
            deadlineAt: commandDeadlineFrom(result.createdAt, component.properties?.ackTimeoutMs),
            waitForPush: runtimeSession.stream?.url ? waitForCommandPush : null,
            onProgress: progress => { if (!cancelled) rememberCommandResult(component, progress) },
          }).then(terminal => {
            if (!cancelled) rememberCommandResult(component, terminal)
          }).catch(error => {
            if (!cancelled) rememberCommandResult(component, {
              ...result,
              ok: false,
              status: 'unknown',
              message: error.message,
              code: error.code || 'COMMAND_STATUS_UNKNOWN',
              correlationId: error.correlationId || result.correlationId,
            })
          })
        }
      } catch {
        // Runtime remains usable if command history cannot be restored.
      }
    }
    restoreRecentCommands()
    return () => { cancelled = true }
  }, [rememberCommandResult, runtime?.projectId, runtime?.schema?.components, runtimeSession?.stream?.url, runtimeSession?.token, waitForCommandPush])

  const runCommand = async (component, tag, requestedValue) => {
    if (profile.id === 'simulation' && component.type === 'operation-shifter') cancelSimulationSequence(component.id)
    const requestedMode = component.type === 'operation-shifter' ? String(requestedValue?.mode || '').toLowerCase() : ''
    if (profile.id === 'simulation' && ['manual', 'reset'].includes(requestedMode)) {
      await manageSimulationResponderLease('takeover').catch(() => null)
    }
    const commandDeadlineAt = Date.now() + commandCompletionBudgetMs(component.properties?.ackTimeoutMs)
    const commandRequestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
    rememberCommandResult(component, {
      ok: false,
      requestId: commandRequestId,
      status: 'requested',
      message: 'Command requested; waiting for authorization.',
      tagId: tag?.id,
      correlationId: null,
      createdAt: new Date().toISOString(),
    })
    try {
      let result
      try {
        result = await apiRequest('/api/commands', { method: 'POST', body: JSON.stringify({ projectId: runtime.projectId, runtimeToken: runtimeSession.token, requestId: commandRequestId, componentId: component.id, confirmed: true, value: requestedValue }) })
      } catch (requestError) {
        if (!requestError.result?.status) throw requestError
        result = requestError.result
      }
      if (isPendingCommandStatus(result.status)) {
        rememberCommandResult(component, result)
        result = await reconcileCommandStatus({
          projectId: runtime.projectId,
          runtimeToken: runtimeSession.token,
          requestId: commandRequestId,
          initialResult: result,
          deadlineAt: commandDeadlineAt,
          waitForPush: runtimeSession.stream?.url ? waitForCommandPush : null,
          onProgress: progress => rememberCommandResult(component, progress),
        })
      }
      if (result.ok && result.tagId) {
        const appliedValue = component.type === 'operation-shifter' && result.value && typeof result.value === 'object'
          ? result.value.mode
          : result.value
        if (profile.id === 'simulation' && component.type === 'operation-shifter' && appliedValue === 'auto') {
          await beginSimulationSequence(component, Array.isArray(requestedValue?.enabledStepIds) ? requestedValue.enabledStepIds : [], result.requestId)
        }
        const feedbackTagId = profile.id === 'simulation' ? component.properties?.feedbackTagId : null
        const rampTargetTagId = profile.id === 'simulation' && component.type === 'tuning-slider'
          ? feedbackTagId || result.tagId
          : null
        if (rampTargetTagId) simulationTargetsRef.current[rampTargetTagId] = Number(result.value)
        const changedTagIds = rampTargetTagId
          ? [result.tagId].filter(tagId => tagId && tagId !== rampTargetTagId)
          : [result.tagId, feedbackTagId].filter(Boolean)
        const immediateChanges = Object.fromEntries(changedTagIds.map(tagId => [tagId, appliedValue]))
        if (profile.id === 'simulation' && component.type === 'operation-shifter' && appliedValue === 'reset') {
          const componentById = new Map((runtime.schema.components || []).map(item => [item.id, item]))
          const tagsById = new Map((runtime.schema.tags || []).map(item => [item.id, item]))
          for (const controlledId of component.properties?.controlledComponentIds || []) {
            const controlled = componentById.get(controlledId)
            if (controlled?.type !== 'control-button') continue
            const commandTag = tagsById.get(controlled.binding?.tagId)
            const feedbackTag = tagsById.get(controlled.properties?.feedbackTagId) || commandTag
            if (commandTag?.dataType === 'boolean') immediateChanges[commandTag.id] = false
            if (feedbackTag?.dataType === 'boolean') immediateChanges[feedbackTag.id] = false
          }
        }
        if (Object.keys(immediateChanges).length) {
          const nextValues = { ...valuesRef.current, ...immediateChanges }
          valuesRef.current = nextValues
          setValues(nextValues)
          setQualities(previous => ({ ...previous, ...Object.fromEntries(Object.keys(immediateChanges).map(tagId => [tagId, 'good'])) }))
          if (profile.id === 'simulation') {
            requestSimulationTelemetryFlush(immediateChanges, { preserveOrder: Boolean(result.resetAfterMs) })
          }
        }
        if (result.resetAfterMs) {
          const resetTagIds = profile.id === 'simulation' ? changedTagIds : [result.tagId]
          window.setTimeout(() => {
            const resetChanges = Object.fromEntries(resetTagIds.filter(Boolean).map(tagId => [tagId, false]))
            const nextValues = { ...valuesRef.current, ...resetChanges }
            valuesRef.current = nextValues
            setValues(nextValues)
            if (profile.id === 'simulation') requestSimulationTelemetryFlush(resetChanges, { preserveOrder: true })
          }, result.resetAfterMs)
        }
      }
      return rememberCommandResult(component, result)
    } catch (requestError) {
      const rejected = Number(requestError.status) >= 400 && Number(requestError.status) < 500
      return rememberCommandResult(component, {
        ok: false,
        requestId: commandRequestId,
        status: rejected ? 'rejected' : 'unknown',
        message: requestError.message,
        code: requestError.code || 'COMMAND_STATUS_UNKNOWN',
        tagId: tag?.id,
        correlationId: requestError.correlationId || null,
      })
    }
  }

  const statusLabel = useMemo(() => state.replaceAll('-', ' ').toUpperCase(), [state])
  const profileStatusLabel = profile.id === 'monitor' ? 'MONITORING' : profile.id.toUpperCase()
  if (session.loading) return <RuntimeState title="Checking runtime access…" />
  if (!session.user) return <RuntimeLogin onAuthenticated={checkSession} />
  if (state === 'project-locked' && lockedProjectId) return <RuntimeProjectUnlock projectId={lockedProjectId} onUnlocked={() => setBootstrapAttempt(attempt => attempt + 1)} />
  if (error) return <RuntimeState title={error} detail={statusLabel} />
  if (!runtime) return <RuntimeState title="Preparing published runtime…" detail={statusLabel} />
  const runtimeConnecting = !runtimeSession || ['connecting', 'reconnecting'].includes(state)
  const runtimeRecovering = runtimeConnecting || ['degraded', 'standby', 'synchronizing', 'disconnected'].includes(state)
  const commandConnectionAvailable = Boolean(runtimeSession?.token)
    && simulationCommandConnectionAvailable(profile.id, state)
    && !runtimeConnecting
    && profile.commandEnabled
  return (
    <div className="sb-published-runtime">
      <div className="sb-runtime-toolbar">
        <div className="sb-runtime-project">
          <strong>{runtime.schema.project.name}</strong>
          <span>Published v{runtime.version} · {runtime.environment.toUpperCase()}</span>
        </div>
        <div className={`sb-runtime-state state-${state}`}>{statusLabel} / {profileStatusLabel}</div>
        <div className="sb-runtime-toolbar-actions">
          <RuntimeViewMenu boardTone={boardTone} onBoardToneChange={setBoardTone} />
          <a href="/">Builder</a>
        </div>
      </div>
      {(runtimeRecovering || showRuntimeReady) && <RuntimeConnectionNotice state={showRuntimeReady && !runtimeRecovering ? 'ready' : state} profile={profile.id} bridgeHealth={simulationBridgeHealth} />}
      {commandNotice && <CommandNotice result={commandNotice} profile={profile.id} bridgeAvailable={runtimeSession?.telemetry?.bridge?.available === true} bridgeHealth={simulationBridgeHealth} onDismiss={() => setCommandNotice(null)} />}
      <RuntimeCanvas schema={runtime.schema} svg={runtime.svg} designAssets={runtime.designAssets} values={values} qualities={qualities} histories={histories} historyStorage={runtime.historyStorage} boardTone={boardTone} actorRole={session.user.role} onCommand={runtimeSession?.token && profile.commandEnabled ? runCommand : undefined} commandResults={commandResults} commandConnectionAvailable={commandConnectionAvailable} />
    </div>
  )
}

function RuntimeConnectionNotice({ state, profile, bridgeHealth }) {
  const ready = state === 'ready'
  const degradedSimulation = state === 'degraded' && profile === 'simulation'
  const content = ready
    ? { title: 'RUNTIME READY', detail: 'Connection restored · operator controls enabled.' }
    : state === 'reconnecting'
      ? { title: 'RECONNECTING RUNTIME', detail: 'Renewing secure runtime session…' }
      : state === 'standby' && profile === 'simulation'
        ? { title: 'SIMULATION BRIDGE STANDBY', detail: 'Another runtime owns the upstream responder · local controls remain available.' }
      : state === 'synchronizing' && profile === 'simulation'
        ? { title: 'SYNCHRONIZING SIMULATION BRIDGE', detail: 'Responder lease acquired · verifying upstream telemetry.' }
      : state === 'degraded'
        ? {
            title: degradedSimulation ? 'SIMULATION BRIDGE DEGRADED' : 'CONNECTION DEGRADED',
            detail: degradedSimulation ? simulationBridgeFailureDetail(bridgeHealth) : 'Waiting for healthy telemetry before enabling controls…',
          }
        : state === 'disconnected'
          ? { title: 'RUNTIME DISCONNECTED', detail: 'Retrying the secure connection…' }
          : { title: 'CONNECTING RUNTIME', detail: 'Session restored · validating telemetry transport…' }
  return (
    <section className={`sb-runtime-connection-notice ${ready ? 'is-ready' : 'is-recovering'}`} role="status" aria-live="polite" aria-atomic="true">
      <span className={ready ? 'sb-runtime-connection-check' : 'sb-runtime-connection-spinner'} aria-hidden="true">{ready ? '✓' : ''}</span>
      <span className="sb-runtime-connection-copy">
        <strong>{content.title}</strong>
        <small>{content.detail}</small>
        <span className="sb-runtime-connection-progress" role="progressbar" aria-label={content.title} aria-valuemin="0" aria-valuemax="100" aria-valuenow={ready ? '100' : undefined}>
          <i />
        </span>
      </span>
    </section>
  )
}

function CommandNotice({ result, profile, bridgeAvailable, bridgeHealth, onDismiss }) {
  const simulationAcknowledged = profile === 'simulation' && result.presentation.state === 'acknowledged'
  const bridgeLabel = !bridgeAvailable
    ? 'local only'
    : bridgeHealth?.status === 'online'
      ? 'online'
      : `unconfirmed (${bridgeHealth?.status || 'unknown'})`
  return (
    <section className={`sb-runtime-message tone-${result.presentation.tone}`} role="status" aria-live="polite" aria-atomic="true">
      <header>
        <span>{simulationAcknowledged ? 'ACKNOWLEDGED LOCALLY' : result.presentation.label}</span>
        <div className="sb-runtime-message-actions">
          <details className="sb-runtime-message-info">
            <summary aria-label="Show command request details" title="Command request details">i</summary>
            <div className="sb-runtime-message-info-popover">
              <strong>COMMAND DETAILS</strong>
              <dl>
                <div><dt>Request</dt><dd>{result.requestId || '—'}</dd></div>
                <div><dt>Correlation</dt><dd>{result.correlationId || 'pending'}</dd></div>
                <div><dt>Observed</dt><dd>{new Date(result.observedAt).toLocaleTimeString()}</dd></div>
                {profile === 'simulation' && <div><dt>Bridge</dt><dd>{bridgeLabel}</dd></div>}
                {result.timing?.mode && <div><dt>{result.timing.mode === 'simulation' ? 'Execution' : 'ACK mode'}</dt><dd>{result.timing.mode}</dd></div>}
                {result.timing?.apiAuthorizationMs != null && <div><dt>API</dt><dd>{formatRpcDuration(result.timing.apiAuthorizationMs)}</dd></div>}
                {result.timing?.workerQueueMs != null && <div><dt>{result.timing.mode === 'simulation' ? 'Dispatch wait' : 'Worker queue'}</dt><dd>{formatRpcDuration(result.timing.workerQueueMs)}</dd></div>}
                {result.timing?.gatewayRpcMs != null && <div><dt>Gateway RPC</dt><dd>{formatRpcDuration(result.timing.gatewayRpcMs)}</dd></div>}
                {result.timing?.upstreamRoundTripMs != null && <div><dt>Upstream</dt><dd>{formatRpcDuration(result.timing.upstreamRoundTripMs)}</dd></div>}
                {result.timing?.feedbackWaitMs != null && <div><dt>Feedback wait</dt><dd>{formatRpcDuration(result.timing.feedbackWaitMs)}</dd></div>}
                {result.timing?.serverTotalMs != null && <div><dt>Server total</dt><dd>{formatRpcDuration(result.timing.serverTotalMs)}</dd></div>}
              </dl>
            </div>
          </details>
          <button type="button" onClick={onDismiss} aria-label="Dismiss command result">×</button>
        </div>
      </header>
      <strong>{result.componentName}</strong>
      <p>{result.message}</p>
    </section>
  )
}

function simulationBridgeFailureDetail(health) {
  const failedChannels = ['telemetry', 'rpc'].filter(channel => health?.[channel]?.healthy === false)
  const channelLabel = failedChannels.length ? failedChannels.join(' + ') : 'upstream'
  const errorCodes = [...new Set(failedChannels.map(channel => health?.[channel]?.lastErrorCode).filter(Boolean))]
  return `${channelLabel} recovering${errorCodes.length ? ` (${errorCodes.join(', ')})` : ''} · local controls remain available.`
}

async function reconcileCommandStatus({ projectId, runtimeToken, requestId, initialResult, deadlineAt, waitForPush = null, onProgress }) {
  const deadline = Number.isFinite(Number(deadlineAt)) ? Number(deadlineAt) : Date.now() + commandCompletionBudgetMs()
  let latest = initialResult
  while (isPendingCommandStatus(latest.status) && Date.now() < deadline) {
    if (waitForPush) {
      const pushed = await waitForPush(requestId, latest.status, Math.min(2000, Math.max(1, deadline - Date.now())))
      if (pushed && commandResultCanReplace(latest, pushed)) {
        latest = pushed
        onProgress(latest)
        continue
      }
    } else {
      await new Promise(resolve => window.setTimeout(resolve, 500))
    }
    if (Date.now() >= deadline) break
    latest = await apiRequest(`/api/commands?projectId=${encodeURIComponent(projectId)}&requestId=${encodeURIComponent(requestId)}`, {
      headers: { 'X-Runtime-Token': runtimeToken },
    })
    onProgress(latest)
  }
  if (isPendingCommandStatus(latest.status)) {
    return {
      ...latest,
      ok: false,
      status: 'unknown',
      message: 'Terminal command status could not be reconciled. Check the audit log before retrying.',
    }
  }
  return latest
}

function waitForSimulationStep(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Simulation sequence cancelled.', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }, Math.max(0, Number(delayMs) || 0))
    const cancel = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Simulation sequence cancelled.', 'AbortError'))
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

function formatRpcDuration(value) {
  const milliseconds = Math.max(0, Number(value) || 0)
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(2)} s` : `${Math.round(milliseconds)} ms`
}

function commandDeadlineFrom(createdAt, acknowledgmentTimeoutMs) {
  const startedAt = new Date(createdAt || 0).getTime()
  return (Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now()) + commandCompletionBudgetMs(acknowledgmentTimeoutMs)
}

function RuntimeViewMenu({ boardTone, onBoardToneChange }) {
  const [open, setOpen] = useState(false)
  const [themeTone, setThemeTone] = useThemeTone()
  const rootRef = useRef(null)
  const triggerRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePress = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('pointerdown', closeOnOutsidePress)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePress)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const choose = callback => {
    callback()
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div className={`sb-view-menu sb-runtime-view-menu ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="sb-view-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="sb-runtime-view-menu"
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="sb-menu-trigger-label">View</span>
        <i className="sb-menu-trigger-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div id="sb-runtime-view-menu" className="sb-view-menu-popover" role="menu" aria-label="Runtime view options">
          <div className="sb-view-menu-summary">
            <span>Runtime view</span>
            <strong>{themeTone === 'cyan' ? 'Cyan' : 'Grey'} · {boardTone === 'dark' ? 'Dark' : 'Light'}</strong>
          </div>
          <button type="button" className="sb-view-menu-item" role="menuitem" onClick={() => choose(() => setThemeTone(themeTone === 'cyan' ? 'grey' : 'cyan'))}>
            <span>Theme tone</span>
            <small>{themeTone === 'cyan' ? 'Cyan' : 'Grey'}</small>
          </button>
          <button type="button" className="sb-view-menu-item" role="menuitem" onClick={() => choose(() => onBoardToneChange(boardTone === 'dark' ? 'light' : 'dark'))}>
            <span>Board appearance</span>
            <small>{boardTone === 'dark' ? 'Dark' : 'Light'}</small>
          </button>
        </div>
      )}
    </div>
  )
}

function RuntimeLogin({ onAuthenticated }) {
  const [email, setEmail] = useState('admin@scada.local'); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const submit = async event => { event.preventDefault(); setBusy(true); setError(''); try { await login(email, password); await onAuthenticated() } catch (requestError) { setError(requestError.message) } finally { setBusy(false) } }
  return <div className="sb-runtime-login"><form className="sb-login-card" onSubmit={submit}><div className="sb-login-card-head"><div className="sb-login-mark">SC</div><ThemeToneToggle /></div><p className="eyebrow">PRIVATE SCADA RUNTIME</p><h1>Runtime access</h1><p>Sign in with an account assigned to this project.</p><label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} required /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} required autoFocus /></label>{error && <div className="sb-form-error">{error}</div>}<button type="submit" className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form></div>
}

function RuntimeProjectUnlock({ projectId, onUnlocked }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async event => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await apiRequest(`/api/projects?id=${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ projectId, action: 'unlock', pin }),
      })
      onUnlocked()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="sb-runtime-login">
      <form className="sb-login-card sb-runtime-pin-card" onSubmit={submit}>
        <div className="sb-login-card-head"><div className="sb-login-mark"><i className="fa-solid fa-lock" /></div><ThemeToneToggle /></div>
        <p className="eyebrow">LOCKED PROJECT</p>
        <h1>Enter project PIN</h1>
        <p>This workspace has an additional security lock.</p>
        <label>6-digit PIN<input className="sb-project-pin-input" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength="6" autoComplete="off" value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} required autoFocus /></label>
        {error && <div className="sb-form-error">{error}</div>}
        <button type="submit" className="primary" disabled={busy || pin.length !== 6}>{busy ? 'Unlocking…' : 'Unlock project'}</button>
        <a className="sb-runtime-pin-back" href="/">Back to Builder</a>
      </form>
    </div>
  )
}

function RuntimeState({ title, detail }) { return <div className="sb-centered-state"><span className="sb-spinner" /><p>{title}</p>{detail && <small>{detail}</small>}</div> }
