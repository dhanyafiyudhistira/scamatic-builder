const STORAGE_KEY = 'scamatic.runtime-responder'
const RESPONDER_ID_PATTERN = /^[a-zA-Z0-9_-]{16,100}$/
const MAX_GENERATION = 2_147_483_647

export function nextRuntimeResponderIdentity({
  storage = globalThis.sessionStorage,
  randomUUID = () => globalThis.crypto?.randomUUID?.() || fallbackId(),
} = {}) {
  let previous = null
  try { previous = JSON.parse(storage?.getItem?.(STORAGE_KEY) || 'null') } catch { /* Start a fresh tab identity. */ }
  const id = validRuntimeResponderId(previous?.id) ? previous.id : randomUUID()
  const priorGeneration = validRuntimeResponderGeneration(previous?.generation) ? Number(previous.generation) : 0
  const generation = priorGeneration >= MAX_GENERATION ? 1 : priorGeneration + 1
  const identity = { id, generation }
  try { storage?.setItem?.(STORAGE_KEY, JSON.stringify(identity)) } catch { /* In-memory identity still works for this request. */ }
  return identity
}

export function validRuntimeResponderId(value) {
  return RESPONDER_ID_PATTERN.test(String(value || ''))
}

export function validRuntimeResponderGeneration(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= MAX_GENERATION
}

function fallbackId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}
