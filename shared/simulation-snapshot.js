export function simulationSnapshotOperations({ schema, telemetryValues, workspaceId, projectId, timestamp, receivedAt = new Date() }) {
  const sequence = Number(timestamp)
  const sourceTimestamp = new Date(sequence)
  return (schema?.tags || []).flatMap(tag => {
    if (!tag?.sourceId || !tag.path || !['read', 'read-write'].includes(tag.access) || telemetryValues[tag.path] == null) return []
    const incomingIsCurrent = { $lte: [{ $ifNull: ['$sequence', -1] }, sequence] }
    const currentOrIncoming = (field, value) => ({
      $cond: [incomingIsCurrent, { $literal: value }, `$${field}`],
    })
    return [{
      updateOne: {
        filter: { _id: `${projectId}:${tag.id}` },
        update: [{
          $set: {
            workspaceId: currentOrIncoming('workspaceId', workspaceId),
            projectId: currentOrIncoming('projectId', projectId),
            sourceId: currentOrIncoming('sourceId', tag.sourceId),
            tagId: currentOrIncoming('tagId', tag.id),
            value: currentOrIncoming('value', telemetryValues[tag.path]),
            dataType: currentOrIncoming('dataType', tag.dataType),
            sourceTimestamp: currentOrIncoming('sourceTimestamp', sourceTimestamp),
            receivedAt: currentOrIncoming('receivedAt', receivedAt),
            quality: currentOrIncoming('quality', 'good'),
            sequence: currentOrIncoming('sequence', sequence),
          },
        }],
        upsert: true,
      },
    }]
  })
}
