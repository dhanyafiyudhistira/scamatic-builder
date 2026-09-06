export const RUNTIME_WORKER_MODES = Object.freeze(['smart', 'always-on', 'on-demand'])
export const DEFAULT_RUNTIME_WORKER_MODE = 'smart'
export const SMART_DRAFT_WARM_MS = 30 * 60 * 1000

export const RUNTIME_WORKER_MODE_META = Object.freeze({
  smart: Object.freeze({
    label: 'SMART',
    description: 'Keeps published runtime connections warm and lets inactive draft connections rest automatically.',
  }),
  'always-on': Object.freeze({
    label: 'ALWAYS ON',
    description: 'Keeps every enabled and configured datasource for this project connected in the background.',
  }),
  'on-demand': Object.freeze({
    label: 'ON DEMAND',
    description: 'Runs datasource connections only while a valid operational runtime session exists.',
  }),
})

export function validRuntimeWorkerMode(value) {
  return RUNTIME_WORKER_MODES.includes(String(value || '').trim().toLowerCase())
}

export function runtimeWorkerMode(value) {
  const candidate = typeof value === 'string' ? value : value?.runtimeWorkerMode
  const normalized = String(candidate || '').trim().toLowerCase()
  return validRuntimeWorkerMode(normalized) ? normalized : DEFAULT_RUNTIME_WORKER_MODE
}

export function runtimeWorkerModeMetadata(value) {
  const id = runtimeWorkerMode(value)
  return { id, ...RUNTIME_WORKER_MODE_META[id] }
}

export function shouldRunProjectWorker(project, {
  hasActiveSession = false,
  selectionMode = null,
  draftUpdatedAt = null,
  now = Date.now(),
  smartDraftWarmMs = SMART_DRAFT_WARM_MS,
} = {}) {
  const mode = runtimeWorkerMode(project)
  if (mode === 'always-on') return true
  if (mode === 'on-demand') return hasActiveSession === true
  if (hasActiveSession === true || selectionMode === 'published') return true
  if (selectionMode !== 'bootstrap') return false

  const updatedAt = new Date(draftUpdatedAt).getTime()
  if (!Number.isFinite(updatedAt)) return true
  const boundedWarmMs = Number.isFinite(smartDraftWarmMs) && smartDraftWarmMs >= 0
    ? smartDraftWarmMs
    : SMART_DRAFT_WARM_MS
  return Math.max(0, Number(now) - updatedAt) <= boundedWarmMs
}
