export function componentTagReferences(component) {
  const references = component?.type === 'chart'
    ? [...(component.binding?.tagIds || [])]
    : [component?.binding?.tagId]
  references.push(component?.properties?.feedbackTagId)
  return [...new Set(references.filter(Boolean))]
}

export function tagUsageCounts(components = []) {
  const counts = new Map()
  for (const component of components) {
    for (const tagId of componentTagReferences(component)) {
      counts.set(tagId, (counts.get(tagId) || 0) + 1)
    }
  }
  return counts
}
