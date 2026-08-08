import { COMPONENT_REGISTRY, createComponentInstance } from './component-registry.js'
import { NODE_RED_EXPORT_MARKER } from './node-red-export.js'

export const NODE_RED_IMPORT_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxNodes: 5000, maxFunctionLength: 100_000 })

const DASHBOARD_TYPES = Object.freeze({
  ui_switch: { dataType: 'boolean', access: 'read-write', componentType: 'control-button' },
  'ui-switch': { dataType: 'boolean', access: 'read-write', componentType: 'control-button' },
  ui_button: { dataType: 'boolean', access: 'write', componentType: 'control-button' },
  'ui-button': { dataType: 'boolean', access: 'write', componentType: 'control-button' },
  ui_slider: { dataType: 'number', access: 'read-write', componentType: 'tuning-slider' },
  'ui-slider': { dataType: 'number', access: 'read-write', componentType: 'tuning-slider' },
  ui_numeric: { dataType: 'number', access: 'read-write', componentType: 'tuning-slider' },
  ui_gauge: { dataType: 'number', access: 'read', componentType: 'value-span' },
  'ui-gauge': { dataType: 'number', access: 'read', componentType: 'value-span' },
  ui_chart: { dataType: 'number', access: 'read', componentType: 'value-span' },
  'ui-chart': { dataType: 'number', access: 'read', componentType: 'value-span' },
  ui_text: { dataType: 'string', access: 'read', componentType: 'value-span' },
  'ui-text': { dataType: 'string', access: 'read', componentType: 'value-span' },
})

export function parseNodeRedFlow(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input)
  if (utf8Size(raw) > NODE_RED_IMPORT_LIMITS.maxBytes) throw new Error('Flow JSON exceeds the 2 MB import limit.')
  let document
  try { document = typeof input === 'string' ? JSON.parse(input) : structuredClone(input) }
  catch { throw new Error('Flow JSON is not valid JSON.') }
  const nodes = Array.isArray(document) ? document : Array.isArray(document?.nodes) ? document.nodes : Array.isArray(document?.flows) ? document.flows : null
  if (!nodes) throw new Error('Node-RED import expects an array of flow nodes.')
  if (!nodes.length) throw new Error('The Node-RED flow does not contain any nodes.')
  if (nodes.length > NODE_RED_IMPORT_LIMITS.maxNodes) throw new Error(`Flow contains more than ${NODE_RED_IMPORT_LIMITS.maxNodes} nodes.`)
  if (nodes.some(node => !isPlainObject(node) || typeof node.type !== 'string')) throw new Error('Every Node-RED entry must be an object with a node type.')

  const nodeMap = new Map(nodes.filter(node => safeText(node.id, 200)).map(node => [safeText(node.id, 200), node]))
  const inbound = inboundNodeMap(nodes)
  const telemetryFunctions = upstreamNodes(nodes.filter(node => node.type === 'mqtt out' && /\/telemetry(?:$|\/)/i.test(safeText(node.topic, 500))), inbound, nodeMap)
    .filter(node => node.type === 'function')
  const telemetryKeys = new Set(telemetryFunctions.flatMap(node => staticPayloadKeys(node.func)))
  const writable = new Map()
  for (const output of nodes.filter(node => node.type === 's7 out' && safeText(node.variable, 255))) {
    const variable = safeText(output.variable, 255)
    const upstream = upstreamNodes([output], inbound, nodeMap).filter(node => node.type === 'function')
    const methods = upstream.flatMap(node => staticRpcMethods(node.func)).filter(method => rpcMethodMatchesVariable(method, variable))
    writable.set(variable, { outputNodeId: safeText(output.id, 200), rpcMethod: methods[0] || null })
  }

  const embedded = embeddedScamaticExport(nodes)
  const candidateMap = new Map()
  for (const candidate of embedded.candidates) mergeCandidate(candidateMap, candidate)
  const endpoints = nodes.filter(node => node.type === 's7 endpoint' && Array.isArray(node.vartable))
  const readsAllByEndpoint = new Set(nodes.filter(node => node.type === 's7 in' && node.mode === 'all').map(node => safeText(node.endpoint, 200)))
  for (const endpoint of endpoints) {
    for (const variable of endpoint.vartable.slice(0, NODE_RED_IMPORT_LIMITS.maxNodes)) {
      const name = safeText(variable?.name, 255)
      if (!name) continue
      const writes = writable.get(name)
      const reads = telemetryKeys.has(name) || (!telemetryKeys.size && readsAllByEndpoint.has(safeText(endpoint.id, 200)))
      if (!reads && !writes) continue
      mergeCandidate(candidateMap, {
        importKey: `s7:${safeText(endpoint.id, 200)}:${name}`,
        name: humanizeName(name),
        path: name,
        dataType: inferS7DataType(variable?.addr, name),
        access: accessMode(reads, Boolean(writes)),
        rpcMethod: writes?.rpcMethod || null,
        componentType: null,
        originNodeIds: [safeText(endpoint.id, 200), writes?.outputNodeId].filter(Boolean),
        plcAddress: safeText(variable?.addr, 100) || null,
        evidence: [reads ? 'telemetry' : null, writes ? 'PLC output' : null].filter(Boolean),
      })
    }
  }

  for (const [name, writes] of writable) {
    if ([...candidateMap.values()].some(candidate => candidate.path === name)) continue
    mergeCandidate(candidateMap, {
      importKey: `s7-output:${writes.outputNodeId}:${name}`,
      name: humanizeName(name),
      path: name,
      dataType: inferNameDataType(name),
      access: 'write',
      rpcMethod: writes.rpcMethod,
      componentType: null,
      originNodeIds: [writes.outputNodeId].filter(Boolean),
      plcAddress: null,
      evidence: ['PLC output'],
    })
  }

  for (const key of telemetryKeys) {
    if ([...candidateMap.values()].some(candidate => candidate.path === key)) continue
    mergeCandidate(candidateMap, {
      importKey: `telemetry:${key}`,
      name: humanizeName(key),
      path: key,
      dataType: inferNameDataType(key),
      access: 'read',
      rpcMethod: null,
      componentType: null,
      originNodeIds: telemetryFunctions.map(node => safeText(node.id, 200)).filter(Boolean),
      plcAddress: null,
      evidence: ['telemetry key'],
    })
  }

  for (const node of nodes) {
    const mapping = DASHBOARD_TYPES[node.type]
    if (!mapping) continue
    const path = safeText(node.topic || node.label || node.name, 255)
    if (!path || /^\{\{.*\}\}$/.test(path)) continue
    mergeCandidate(candidateMap, {
      importKey: `dashboard:${safeText(node.id, 200) || path}`,
      name: humanizeName(node.label || node.name || path),
      path,
      ...mapping,
      rpcMethod: null,
      originNodeIds: [safeText(node.id, 200)].filter(Boolean),
      plcAddress: null,
      evidence: ['dashboard node'],
    })
  }

  const candidates = [...candidateMap.values()].map(({ metadataAuthority, ...candidate }) => ({
    ...candidate,
    componentType: candidate.componentType || suggestedComponentType(candidate),
  })).sort((a, b) => a.name.localeCompare(b.name))
  if (!candidates.length) throw new Error('No importable S7 variables, telemetry keys, or supported dashboard nodes were found.')

  const tabs = nodes.filter(node => node.type === 'tab').map(node => safeText(node.label || node.name, 120)).filter(Boolean)
  const warnings = ['Function-node JavaScript was inspected only for safe static property and RPC names; it was never executed.']
  if (embedded.candidates.length) warnings.push(`Found ${embedded.candidates.length} tag${embedded.candidates.length === 1 ? '' : 's'} in validated Scamatic Builder round-trip metadata.`)
  if (!telemetryKeys.size && endpoints.length) warnings.push('No static ThingsBoard telemetry object was found; readable S7 variables were inferred from S7 input nodes.')
  if (candidates.some(candidate => candidate.dataType === 'number' && candidate.access !== 'read')) warnings.push('Review numeric control ranges after import; flow exports do not reliably describe engineering limits.')
  if (candidates.some(candidate => candidate.access === 'write' && !candidate.rpcMethod)) warnings.push('Some writable tags have no statically detectable RPC method and need manual command mapping.')

  return {
    format: 'node-red',
    fingerprint: `nr-${stableHash(nodes.map(fingerprintNode))}`,
    flowName: tabs[0] || 'Node-RED flow',
    nodeCount: nodes.length,
    candidates,
    warnings,
    stats: {
      endpoints: endpoints.length,
      telemetryKeys: telemetryKeys.size,
      writableVariables: writable.size,
      supportedDashboardNodes: nodes.filter(node => DASHBOARD_TYPES[node.type]).length,
      embeddedScamaticTags: embedded.candidates.length,
    },
  }
}

export function createNodeRedImportPlan(analysis, schema, options = {}) {
  if (analysis?.format !== 'node-red' || !Array.isArray(analysis.candidates)) throw new Error('A valid Node-RED analysis is required.')
  const sourceId = String(options.sourceId || '')
  if (!schema?.dataSources?.some(source => source.id === sourceId)) throw new Error('Select an existing Builder data source for imported tags.')
  const selectedKeys = options.selectedKeys ? new Set(options.selectedKeys) : new Set(analysis.candidates.map(candidate => candidate.importKey))
  const componentKeys = options.componentKeys ? new Set(options.componentKeys) : new Set(analysis.candidates.filter(candidate => candidate.componentType).map(candidate => candidate.importKey))
  const existingTagIds = new Set((schema.tags || []).map(tag => tag.id))
  const existingBySourcePath = new Map((schema.tags || []).map(tag => [`${tag.sourceId}:${tag.path}`, tag]))
  const importedByKey = new Map((schema.tags || []).filter(tag => tag.metadata?.importSource === 'node-red').map(tag => [tag.metadata.importKey, tag]))
  const tags = []
  const resolvedTags = new Map()
  let tagsReused = 0

  for (const candidate of analysis.candidates.filter(item => selectedKeys.has(item.importKey))) {
    const existing = importedByKey.get(candidate.importKey) || existingBySourcePath.get(`${sourceId}:${candidate.path}`)
    if (existing) {
      resolvedTags.set(candidate.importKey, existing)
      tagsReused += 1
      continue
    }
    const id = uniqueId(`flow.${slugPart(candidate.path) || 'tag'}`, existingTagIds)
    existingTagIds.add(id)
    const tag = {
      id,
      name: candidate.name,
      path: candidate.path,
      dataType: candidate.dataType,
      access: candidate.access,
      sourceId,
      freshnessMode: candidate.access === 'write' ? 'event-driven' : 'periodic',
      adaptiveFreshness: candidate.access !== 'write',
      staleAfterMs: 10_000,
      metadata: importMetadata(analysis, candidate),
    }
    tags.push(tag)
    resolvedTags.set(candidate.importKey, tag)
  }

  const occupied = [...(schema.components || [])]
  const existingComponentKeys = new Set((schema.components || []).map(component => component.metadata?.importKey).filter(Boolean))
  const existingBindingKeys = new Set((schema.components || []).map(component => `${component.type}:${component.binding?.tagId || ''}`))
  const componentIds = new Set((schema.components || []).map(component => component.id))
  const components = []
  let componentsReused = 0
  const warnings = [...(analysis.warnings || [])]

  for (const candidate of analysis.candidates.filter(item => selectedKeys.has(item.importKey) && componentKeys.has(item.importKey) && item.componentType)) {
    const tag = resolvedTags.get(candidate.importKey)
    const componentKey = `node-red:${candidate.importKey}:${candidate.componentType}`
    if (existingComponentKeys.has(componentKey) || existingBindingKeys.has(`${candidate.componentType}:${tag?.id || ''}`)) {
      componentsReused += 1
      continue
    }
    if (!tag || !COMPONENT_REGISTRY[candidate.componentType]) continue
    const id = uniqueId(`cmp_flow_${slugPart(candidate.path) || 'item'}`, componentIds)
    componentIds.add(id)
    const component = createComponentInstance(candidate.componentType, { id, canvas: schema.project.canvas, tagId: tag.id, index: occupied.length })
    component.name = candidate.name
    component.properties = {
      ...component.properties,
      ...safeImportedComponentProperties(candidate.componentType, candidate.componentProperties),
      label: candidate.componentProperties?.label || candidate.name.toUpperCase(),
      ...(candidate.rpcMethod ? { rpcMethod: candidate.rpcMethod } : {}),
    }
    component.metadata = { ...importMetadata(analysis, candidate), importKey: componentKey }
    const placement = findAvailablePosition(component.position, occupied, schema.project.canvas)
    component.position = placement.position
    if (placement.fallback) component.metadata.placementFallback = true
    occupied.push(component)
    components.push(component)
    existingComponentKeys.add(componentKey)
    existingBindingKeys.add(`${candidate.componentType}:${tag.id}`)
  }

  const unplaced = components.filter(component => component.metadata?.placementFallback).length
  if (unplaced) warnings.push(`${unplaced} component${unplaced === 1 ? '' : 's'} could not find an empty grid slot and may overlap existing content.`)
  return {
    format: 'node-red',
    fingerprint: analysis.fingerprint,
    sourceId,
    tags,
    components,
    warnings: [...new Set(warnings)],
    stats: {
      candidates: selectedKeys.size,
      tagsCreated: tags.length,
      tagsReused,
      componentsCreated: components.length,
      componentsReused,
    },
  }
}

export function applyNodeRedImportPlan(schema, plan) {
  if (plan?.format !== 'node-red') throw new Error('A valid Node-RED import plan is required.')
  return {
    ...schema,
    tags: [...(schema.tags || []), ...plan.tags],
    components: [...(schema.components || []), ...plan.components],
  }
}

function mergeCandidate(map, candidate) {
  const key = candidate.path.toLowerCase()
  const previous = map.get(key)
  if (!previous) return map.set(key, candidate)
  if (previous.metadataAuthority || candidate.metadataAuthority) {
    const authoritative = previous.metadataAuthority ? previous : candidate
    const secondary = previous.metadataAuthority ? candidate : previous
    return map.set(key, {
      ...secondary,
      ...authoritative,
      rpcMethod: authoritative.rpcMethod || secondary.rpcMethod,
      componentType: authoritative.componentType || secondary.componentType,
      componentProperties: authoritative.componentProperties || secondary.componentProperties,
      originNodeIds: [...new Set([...authoritative.originNodeIds, ...secondary.originNodeIds])],
      evidence: [...new Set([...authoritative.evidence, ...secondary.evidence])],
    })
  }
  const reads = previous.access !== 'write' || candidate.access !== 'write'
  const writes = previous.access !== 'read' || candidate.access !== 'read'
  map.set(key, {
    ...previous,
    access: accessMode(reads, writes),
    rpcMethod: previous.rpcMethod || candidate.rpcMethod,
    componentType: previous.componentType || candidate.componentType,
    componentProperties: previous.componentProperties || candidate.componentProperties,
    originNodeIds: [...new Set([...previous.originNodeIds, ...candidate.originNodeIds])],
    evidence: [...new Set([...previous.evidence, ...candidate.evidence])],
  })
}

function embeddedScamaticExport(nodes) {
  for (const node of nodes) {
    if (node?.type !== 'comment') continue
    const info = safeText(node.info, NODE_RED_IMPORT_LIMITS.maxBytes)
    if (!info.startsWith(`${NODE_RED_EXPORT_MARKER}\n`)) continue
    let metadata
    try { metadata = JSON.parse(info.slice(NODE_RED_EXPORT_MARKER.length + 1)) }
    catch { continue }
    if (metadata?.format !== 'scamatic-builder' || metadata?.version !== 1 || !Array.isArray(metadata.tags) || metadata.tags.length > NODE_RED_IMPORT_LIMITS.maxNodes) continue
    const originNodeId = safeText(node.id, 200)
    const candidates = metadata.tags.map(tag => {
      const id = safeText(tag?.id, 200)
      const path = safeText(tag?.path, 255)
      const dataType = ['boolean', 'number', 'string', 'enum', 'datetime'].includes(tag?.dataType) ? tag.dataType : null
      const access = ['read', 'write', 'read-write'].includes(tag?.access) ? tag.access : null
      if (!id || !path || !dataType || !access) return null
      const componentType = COMPONENT_REGISTRY[tag.componentType] ? tag.componentType : null
      return {
        importKey: `scamatic:${id}`,
        name: safeText(tag.name, 255) || humanizeName(path),
        path,
        dataType,
        access,
        rpcMethod: /^[a-zA-Z0-9_.:-]{1,100}$/.test(tag.rpcMethod || '') ? tag.rpcMethod : null,
        componentType,
        componentProperties: safeImportedComponentProperties(componentType, tag.componentProperties),
        originNodeIds: originNodeId ? [originNodeId] : [],
        plcAddress: safeText(tag.plcAddress, 100) || null,
        evidence: ['Scamatic Builder metadata'],
        metadataAuthority: true,
      }
    }).filter(Boolean)
    return { candidates }
  }
  return { candidates: [] }
}

function safeImportedComponentProperties(type, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  const label = safeText(value.label, 255)
  if (label) result.label = label
  if (['tuning-slider', 'value-span'].includes(type)) {
    const min = Number(value.min)
    const max = Number(value.max)
    if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
      result.min = min
      result.max = max
    }
    const step = Number(value.step)
    if (Number.isFinite(step) && step > 0) result.step = step
    const decimals = Number(value.decimals)
    if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 8) result.decimals = decimals
    const suffix = safeText(value.suffix, 40)
    if (suffix) result.suffix = suffix
  }
  if (type === 'control-button') {
    const action = safeText(value.action, 40)
    if (/^(?:toggle-boolean|set-value|pulse)$/.test(action)) result.action = action
    if (['boolean', 'number', 'string'].includes(typeof value.payload)) result.payload = value.payload
  }
  return result
}

function inboundNodeMap(nodes) {
  const inbound = new Map()
  for (const node of nodes) {
    for (const targetId of (Array.isArray(node.wires) ? node.wires.flat(2) : []).filter(Boolean)) {
      if (!inbound.has(targetId)) inbound.set(targetId, [])
      inbound.get(targetId).push(safeText(node.id, 200))
    }
  }
  return inbound
}

function upstreamNodes(starts, inbound, nodeMap) {
  const found = []
  const queue = starts.map(node => safeText(node.id, 200)).filter(Boolean)
  const visited = new Set(queue)
  while (queue.length && visited.size <= NODE_RED_IMPORT_LIMITS.maxNodes) {
    const id = queue.shift()
    const node = nodeMap.get(id)
    if (node) found.push(node)
    for (const parent of inbound.get(id) || []) {
      if (visited.has(parent)) continue
      visited.add(parent)
      queue.push(parent)
    }
  }
  return found
}

function staticPayloadKeys(value) {
  const code = safeText(value, NODE_RED_IMPORT_LIMITS.maxFunctionLength)
  const keys = new Set()
  const pattern = /msg\.payload(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g
  for (const match of code.matchAll(pattern)) {
    const key = safeText(match[1] || match[2], 255)
    if (key) keys.add(key)
  }
  return [...keys]
}

function staticRpcMethods(value) {
  const code = safeText(value, NODE_RED_IMPORT_LIMITS.maxFunctionLength)
  const methods = new Set()
  const patterns = [/case\s+['"]([A-Za-z0-9_.:-]{1,100})['"]\s*:/g, /(?:request\.)?method\s*={2,3}\s*['"]([A-Za-z0-9_.:-]{1,100})['"]/g]
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) methods.add(match[1])
  return [...methods]
}

function rpcMethodMatchesVariable(method, variable) {
  const normalizedMethod = String(method).replace(/^set/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  const normalizedVariable = String(variable).replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalizedMethod === normalizedVariable || normalizedMethod.endsWith(normalizedVariable)
}

function inferS7DataType(address, name) {
  const value = safeText(address, 100).toUpperCase()
  if (/^(?:[IQM]X?\d+\.\d+|DB\d+\.DBX\d+\.\d+)$/.test(value)) return 'boolean'
  if (/^(?:[IQM](?:B|W|D)\d+|DB\d+\.DB(?:B|W|D)\d+)$/.test(value)) return 'number'
  return inferNameDataType(name)
}

function inferNameDataType(name) {
  return /level|temp|pressure|flow|speed|setpoint|value|count|rate|weight|volume|current|voltage/i.test(String(name)) ? 'number' : 'boolean'
}

function suggestedComponentType(candidate) {
  if (candidate.dataType === 'boolean') return candidate.access === 'read' ? 'indicator-lamp' : 'control-button'
  if (candidate.dataType === 'number') return candidate.access === 'read' ? 'value-span' : 'tuning-slider'
  if (['string', 'enum', 'datetime'].includes(candidate.dataType) && candidate.access === 'read') return 'value-span'
  if (candidate.dataType === 'enum' && candidate.access !== 'read') return 'operation-shifter'
  return null
}

function accessMode(reads, writes) {
  return reads && writes ? 'read-write' : writes ? 'write' : 'read'
}

function importMetadata(analysis, candidate) {
  return {
    importSource: 'node-red',
    importFingerprint: analysis.fingerprint,
    importKey: candidate.importKey,
    originNodeIds: candidate.originNodeIds.slice(0, 20),
    ...(candidate.plcAddress ? { plcAddress: candidate.plcAddress } : {}),
  }
}

function findAvailablePosition(position, occupied, canvas) {
  const gap = 20
  const stepX = Math.max(120, Math.ceil((position.width + gap) / 20) * 20)
  const stepY = Math.max(100, Math.ceil((position.height + gap) / 20) * 20)
  for (let y = gap; y + position.height <= canvas.height - gap; y += stepY) {
    for (let x = gap; x + position.width <= canvas.width - gap; x += stepX) {
      const candidate = { ...position, x, y }
      if (!occupied.some(component => overlaps(candidate, component.position, gap / 2))) return { position: candidate, fallback: false }
    }
  }
  return {
    position: {
      ...position,
      x: Math.max(0, Math.min(canvas.width - position.width, gap + (occupied.length % 5) * gap)),
      y: Math.max(0, Math.min(canvas.height - position.height, gap + (occupied.length % 7) * gap)),
    },
    fallback: true,
  }
}

function overlaps(a, b, gap = 0) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y
}

function uniqueId(base, used) {
  let id = base
  let suffix = 2
  while (used.has(id)) id = `${base}_${suffix++}`
  return id
}

function humanizeName(value) {
  return safeText(value, 255).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim() || 'Imported tag'
}

function slugPart(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
}

function stableHash(value) {
  const input = JSON.stringify(value)
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function fingerprintNode(node) {
  return {
    id: safeText(node.id, 200),
    type: safeText(node.type, 100),
    name: safeText(node.name || node.label, 200),
    topic: safeText(node.topic, 500),
    variable: safeText(node.variable, 255),
    endpoint: safeText(node.endpoint, 200),
    variables: Array.isArray(node.vartable) ? node.vartable.slice(0, NODE_RED_IMPORT_LIMITS.maxNodes).map(item => ({ name: safeText(item?.name, 255), addr: safeText(item?.addr, 100) })) : undefined,
    functionHash: node.type === 'function' ? stableHash(safeText(node.func, NODE_RED_IMPORT_LIMITS.maxFunctionLength)) : undefined,
  }
}

function safeText(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function utf8Size(value) {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(value).byteLength : value.length
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
