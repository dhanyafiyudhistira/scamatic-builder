export function createControlCommandIntentQueue({ action = 'toggle-boolean', currentValue = false, payload = true } = {}) {
  let configuredAction = action
  let configuredPayload = payload
  let desiredValue = currentValue
  let inFlight = false
  let inFlightValue
  let queued = false
  let queuedValue
  let queuedIntentAt

  const snapshot = () => ({
    inFlight,
    queued,
    desiredValue,
  })

  const configure = ({ action: nextAction = configuredAction, payload: nextPayload = configuredPayload } = {}) => {
    configuredAction = nextAction
    configuredPayload = nextPayload
  }

  const sync = value => {
    if (!inFlight && !queued) desiredValue = value
    return snapshot()
  }

  const press = (value, { intentAt = null } = {}) => {
    const normalizedIntentAt = finiteTimestamp(intentAt)
    if (configuredAction === 'toggle-boolean') {
      const base = inFlight || queued ? desiredValue : value
      desiredValue = !Boolean(base)
      if (!inFlight) return begin(desiredValue, normalizedIntentAt)
      queued = true
      queuedValue = desiredValue
      queuedIntentAt = normalizedIntentAt
      return intentResult('queued', queuedValue, queuedIntentAt, snapshot())
    }

    if (configuredAction === 'pulse') {
      if (!inFlight) return begin(undefined, normalizedIntentAt)
      if (!queued) queuedIntentAt = normalizedIntentAt
      queued = true
      return intentResult('queued', undefined, queuedIntentAt, snapshot())
    }

    if (!inFlight) return begin(configuredPayload, normalizedIntentAt)
    // Repeating a fixed set-value command while the same value is in flight
    // has no additional effect, so retain only its current intent.
    return { kind: 'coalesced', value: configuredPayload, state: snapshot() }
  }

  const settle = result => {
    const acknowledged = result?.ok === true && result?.status === 'acknowledged'
    const completedValue = result?.value
    inFlight = false
    inFlightValue = undefined

    if (!acknowledged) {
      queued = false
      queuedValue = undefined
      queuedIntentAt = undefined
      return { kind: 'idle', state: snapshot() }
    }

    if (configuredAction === 'toggle-boolean') {
      const completedBoolean = Boolean(completedValue)
      const nextValue = queuedValue
      const nextIntentAt = queuedIntentAt
      const shouldDispatch = queued && Boolean(nextValue) !== completedBoolean
      queued = false
      queuedValue = undefined
      queuedIntentAt = undefined
      if (shouldDispatch) return begin(Boolean(nextValue), nextIntentAt)
      desiredValue = completedBoolean
      return { kind: 'idle', state: snapshot() }
    }

    if (configuredAction === 'pulse' && queued) {
      const nextIntentAt = queuedIntentAt
      queued = false
      queuedIntentAt = undefined
      return begin(undefined, nextIntentAt)
    }

    queued = false
    queuedValue = undefined
    queuedIntentAt = undefined
    desiredValue = completedValue
    return { kind: 'idle', state: snapshot() }
  }

  function begin(value, intentAt) {
    inFlight = true
    inFlightValue = value
    return intentResult('dispatch', inFlightValue, intentAt, snapshot())
  }

  return { configure, press, settle, snapshot, sync }
}

function finiteTimestamp(value) {
  if (value == null || value === '') return null
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null
}

function intentResult(kind, value, intentAt, state) {
  return { kind, value, ...(intentAt != null ? { intentAt } : {}), state }
}
