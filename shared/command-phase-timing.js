const MEASURED_COMMAND_PHASES = new Set([
  'principalAuthMs',
  'rateLimitPersistMs',
  'admissionReadsMs',
  'authorizationPolicyMs',
  'versionLoadMs',
  'simulationStateReadsMs',
  'commandCreateMs',
  'authorizationPersistMs',
  'authorizationAuditMs',
  'dispatchPersistMs',
  'terminalPersistMs',
  'terminalAuditMs',
])

export const COMMAND_PHASE_TIMING_FIELDS = Object.freeze([
  ...MEASURED_COMMAND_PHASES,
  'admissionTotalMs',
  'commandPersistenceMs',
  'auditPersistenceMs',
  'serverResponseReadyMs',
  'unattributedMs',
])

export function createCommandPhaseTimer({ now = monotonicNow, enabled = true } = {}) {
  if (!enabled) {
    return {
      measure(field, operation) {
        validateMeasurement(field, operation)
        return operation()
      },
      snapshot() {
        return null
      },
    }
  }
  const requestStartedAt = readClock(now)
  const phases = {}

  return {
    async measure(field, operation) {
      validateMeasurement(field, operation)
      const startedAt = readClock(now)
      try {
        return await operation()
      } finally {
        const duration = elapsed(startedAt, readClock(now))
        if (duration != null) phases[field] = duration
      }
    },
    snapshot() {
      const timing = { ...phases }
      const responseReady = elapsed(requestStartedAt, readClock(now))
      if (responseReady != null) timing.serverResponseReadyMs = responseReady

      const admissionTotal = sumPresent(timing, [
        'principalAuthMs',
        'rateLimitPersistMs',
        'admissionReadsMs',
        'authorizationPolicyMs',
        'versionLoadMs',
        'simulationStateReadsMs',
      ])
      const commandPersistence = sumPresent(timing, ['commandCreateMs', 'authorizationPersistMs', 'dispatchPersistMs'])
      const auditPersistence = sumPresent(timing, ['authorizationAuditMs', 'terminalAuditMs'])
      if (admissionTotal != null) timing.admissionTotalMs = admissionTotal
      if (commandPersistence != null) timing.commandPersistenceMs = commandPersistence
      if (auditPersistence != null) timing.auditPersistenceMs = auditPersistence

      if (responseReady != null) {
        const measured = sumPresent(timing, [...MEASURED_COMMAND_PHASES]) || 0
        timing.unattributedMs = Math.max(0, responseReady - measured)
      }
      return timing
    },
  }
}

function validateMeasurement(field, operation) {
  if (!MEASURED_COMMAND_PHASES.has(field)) throw new TypeError(`Unsupported command phase: ${field}`)
  if (typeof operation !== 'function') throw new TypeError('Command phase operation must be a function.')
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now()
}

function readClock(now) {
  try {
    const value = Number(now())
    return Number.isFinite(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

function elapsed(start, end) {
  if (start == null || end == null || end < start) return null
  return Math.round(end - start)
}

function sumPresent(value, fields) {
  const durations = fields.map(field => value[field]).filter(item => Number.isFinite(item) && item >= 0)
  return durations.length ? durations.reduce((total, item) => total + item, 0) : null
}
