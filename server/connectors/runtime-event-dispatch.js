export function dispatchRuntimeEvent({
  mode,
  event,
  environmentId,
  hub,
  snapshotWriter,
  archiveWriter = null,
  healthWriter,
}) {
  if (mode === 'bootstrap') return false
  hub.publish(event)
  snapshotWriter.enqueue(event)
  archiveWriter?.enqueue(event)
  healthWriter.enqueue({ environmentId, receivedAt: event.receivedAt })
  return true
}
