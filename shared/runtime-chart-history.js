export function runtimeChartHistoryRequest(schema, { now = Date.now(), maxBootstrapPoints = 10_000 } = {}) {
  const tags = new Map((schema?.tags || []).map(tag => [tag.id, tag]))
  const components = (schema?.components || []).filter(component => component.type === 'chart' && component.visible !== false)
  const tagIds = [...new Set(components.flatMap(component => component.binding?.tagIds || []))]
    .filter(tagId => {
      const tag = tags.get(tagId)
      return tag?.dataType === 'number' && ['read', 'read-write'].includes(tag.access)
    })
    .slice(0, 50)
  if (!tagIds.length) return null
  const windowMinutes = Math.max(...components.map(component => bounded(component.properties?.windowMinutes, 1, 1440, 60)))
  const requestedLimit = Math.max(...components.map(component => bounded(component.properties?.historyLimit, 30, 2000, 300)))
  const fairLimit = Math.max(1, Math.floor(maxBootstrapPoints / tagIds.length))
  return {
    tagIds,
    since: new Date(now - windowMinutes * 60_000),
    limitPerTag: Math.min(requestedLimit, fairLimit, 2000),
    windowMinutes,
  }
}

function bounded(value, min, max, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}
