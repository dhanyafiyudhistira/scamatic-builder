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
