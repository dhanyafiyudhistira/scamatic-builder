export function connectorSourceUsage(schema, connectorId) {
  const sourceIds = (schema?.dataSources || [])
    .filter(source => String(source.connectorRef || '') === String(connectorId || ''))
    .map(source => source.id)
  const sourceIdSet = new Set(sourceIds)
  const tagCount = (schema?.tags || []).filter(tag => sourceIdSet.has(tag.sourceId)).length
  return { attached: sourceIds.length > 0, sourceIds, tagCount }
}

export function detachUnusedConnectorSources(schema, connectorId) {
  const usage = connectorSourceUsage(schema, connectorId)
  if (!usage.attached) return { ok: true, schema, usage }
  if (usage.tagCount > 0) return { ok: false, schema, usage }
  const sourceIdSet = new Set(usage.sourceIds)
  return {
    ok: true,
    usage,
    schema: {
      ...schema,
      dataSources: (schema.dataSources || []).filter(source => !sourceIdSet.has(source.id)),
    },
  }
}

export function connectorDeletionBlock({ enabled = false, draftAttached = false, draftDirty = false } = {}) {
  if (enabled) return { code: 'CONNECTOR_ENABLED', message: 'Disable the connector before deleting it.' }
  if (draftAttached) return { code: 'CONNECTOR_IN_DRAFT', message: 'Detach the connector from the saved draft before deleting it.' }
  if (draftDirty) return { code: 'DRAFT_DIRTY', message: 'Save the draft before deleting the connector.' }
  return null
}
