const MAX_IMPORT_KEYS = 100

export function applyDiscoveredThingsBoardTags(schema, { connectorId, keys = [] }) {
  const source = (schema?.dataSources || []).find(item => item.type === 'thingsboard' && item.connectorRef === connectorId)
  if (!source) throw new TypeError('Attach the ThingsBoard connector before importing telemetry.')
  const selected = Array.isArray(keys) ? keys.slice(0, MAX_IMPORT_KEYS) : []
  const existingPaths = new Set((schema.tags || []).map(tag => tag.path))
  const existingIds = new Set((schema.tags || []).map(tag => tag.id))
  const created = []
  let skipped = 0

  for (const descriptor of selected) {
    const path = cleanText(descriptor?.key, 255)
    if (!path || existingPaths.has(path)) { skipped += 1; continue }
    const dataType = normalizeDataType(descriptor?.dataType)
    const tag = {
      id: uniqueTagId(path, existingIds),
      name: telemetryName(path),
      path,
      dataType,
      access: 'read',
      sourceId: source.id,
      freshnessMode: 'periodic',
      adaptiveFreshness: true,
      staleAfterMs: 10_000,
      ...(dataType === 'number' ? { numberFormat: 'number', engineering: { min: 0, max: 100, unit: '', decimals: 1 } } : {}),
    }
    existingPaths.add(path)
    existingIds.add(tag.id)
    created.push(tag)
  }

  return {
    schema: { ...schema, tags: [...(schema.tags || []), ...created] },
    tags: created,
    stats: { created: created.length, skipped },
  }
}

function normalizeDataType(value) {
  return ['boolean', 'number', 'string', 'datetime'].includes(value) ? value : 'string'
}

function uniqueTagId(path, used) {
  const stem = `tag_${String(path).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 160) || 'telemetry'}`
  let id = stem
  let counter = 2
  while (used.has(id)) id = `${stem.slice(0, 190)}_${counter++}`
  return id
}

function telemetryName(path) {
  const name = String(path).split(/[./:_-]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
  return cleanText(name || path, 160)
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength)
}
