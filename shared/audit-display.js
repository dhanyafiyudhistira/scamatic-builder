const TECHNICAL_WORDS = new Map([
  ['api', 'API'],
  ['id', 'ID'],
  ['isaac', 'Isaac'],
  ['jwt', 'JWT'],
  ['rpc', 'RPC'],
  ['svg', 'SVG'],
])

export function auditActionLabel(action) {
  const words = String(action || 'unknown event').split(/[._-]+/).filter(Boolean)
  return words.map((word, index) => {
    const normalized = word.toLowerCase()
    if (TECHNICAL_WORDS.has(normalized)) return TECHNICAL_WORDS.get(normalized)
    return index === 0 ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : normalized
  }).join(' ')
}

export function auditActionCategory(action) {
  const category = String(action || 'system').split(/[._-]+/).find(Boolean) || 'system'
  return category.toUpperCase()
}
