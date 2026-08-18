export function createKeyedTaskQueue({
  maxPending = 200,
  onError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const capacity = positiveInteger(maxPending, 200)
  const lanes = new Map()
  const pendingIds = new Set()
  const idleWaiters = new Set()
  let accepting = true
  let active = 0
  let queued = 0
  let completed = 0
  let failed = 0
  let canceled = 0

  const snapshot = () => ({
    accepting,
    capacity,
    active,
    queued,
    pending: active + queued,
    lanes: lanes.size,
    completed,
    failed,
    canceled,
  })

  const notifyIdle = () => {
    if (active || queued) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  const startNext = (key, lane) => {
    if (lane.active) return
    const entry = lane.queue.shift()
    if (!entry) {
      lanes.delete(key)
      notifyIdle()
      return
    }
    queued -= 1
    active += 1
    lane.active = true
    Promise.resolve()
      .then(entry.task)
      .catch(error => {
        failed += 1
        try { onError(error, { id: entry.id, key, ...snapshot() }) } catch {}
      })
      .finally(() => {
        active -= 1
        completed += 1
        lane.active = false
        if (entry.id) pendingIds.delete(entry.id)
        startNext(key, lane)
      })
  }

  return {
    enqueue(key, task, { id = null, onCancel = () => {} } = {}) {
      if (!accepting || typeof task !== 'function' || active + queued >= capacity) return false
      const laneKey = String(key || '')
      const taskId = id == null ? null : String(id)
      if (!laneKey || (taskId && pendingIds.has(taskId))) return false
      const lane = lanes.get(laneKey) || { active: false, queue: [] }
      lane.queue.push({ id: taskId, task, onCancel })
      lanes.set(laneKey, lane)
      queued += 1
      if (taskId) pendingIds.add(taskId)
      startNext(laneKey, lane)
      return true
    },
    pendingIds() {
      return [...pendingIds]
    },
    snapshot,
    async close({ timeoutMs = 35_000, cancelPending = true } = {}) {
      accepting = false
      if (cancelPending) {
        for (const [key, lane] of lanes) {
          while (lane.queue.length) {
            const entry = lane.queue.shift()
            queued -= 1
            canceled += 1
            if (entry.id) pendingIds.delete(entry.id)
            try { entry.onCancel({ id: entry.id, key }) } catch {}
          }
          if (!lane.active) lanes.delete(key)
        }
      }
      notifyIdle()
      if (!active && !queued) return { ...snapshot(), timedOut: false }

      const idle = new Promise(resolve => idleWaiters.add(resolve))
      const timeout = positiveInteger(timeoutMs, 35_000)
      let timer
      const timedOut = await Promise.race([
        idle.then(() => false),
        new Promise(resolve => { timer = setTimer(() => resolve(true), timeout) }),
      ])
      if (timer) clearTimer(timer)
      if (timedOut) idleWaiters.clear()
      return { ...snapshot(), timedOut }
    },
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
