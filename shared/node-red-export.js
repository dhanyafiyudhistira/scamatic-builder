import { COMPONENT_REGISTRY } from './component-registry.js'

export const NODE_RED_EXPORT_VERSION = 1
export const NODE_RED_EXPORT_MARKER = 'SCAMATIC_BUILDER_EXPORT_V1'
export const NODE_RED_EXPORT_LIMITS = Object.freeze({ maxNodes: 5000, maxMetadataBytes: 1024 * 1024 })

const DATA_TYPES = new Set(['boolean', 'number', 'string', 'enum', 'datetime'])
const ACCESS_MODES = new Set(['read', 'write', 'read-write'])
const DASHBOARD_COMPONENT_TYPES = new Set(['indicator-lamp', 'value-span', 'control-button', 'tuning-slider', 'operation-shifter', 'chart'])
const IMPORTABLE_COMPONENT_TYPES = new Set(Object.keys(COMPONENT_REGISTRY).filter(type => !['text-label', 'design-image', 'control-popup'].includes(type)))

export function createNodeRedExport(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('A valid Builder project schema is required.')
  const project = sanitizeProject({ ...schema.project, schemaVersion: schema.schemaVersion })
  const sourceTypes = new Map((Array.isArray(schema.dataSources) ? schema.dataSources : []).map(source => [safeText(source?.id, 200), safeSourceType(source?.type)]))
  const tags = (Array.isArray(schema.tags) ? schema.tags : []).map(tag => sanitizeTag(tag, sourceTypes)).filter(Boolean)
  const tagById = new Map(tags.map(tag => [tag.id, tag]))
  const components = (Array.isArray(schema.components) ? schema.components : []).map(component => sanitizeComponent(component, tagById)).filter(Boolean)
  const componentByTag = firstComponentByTag(components)
  const warnings = []
  const usedIds = new Set()
  const id = seed => deterministicNodeId(`${project.id}:${seed}`, usedIds)
  const tabId = id('tab')
  const brokerId = id('thingsboard-broker')
  const endpointId = id('s7-endpoint')
  const metadataId = id('scamatic-metadata')
  const setupCommentId = id('setup-comment')
  const nodes = []

  const usedRpcMethods = new Set()
  let adjustedRpcMethods = 0
  const exportedTags = tags.map(tag => {
    const component = componentByTag.get(tag.id)
    const requestedRpcMethod = tag.access === 'read' ? null : rpcMethodForTag(tag, component)
    const rpcMethod = requestedRpcMethod ? uniqueRpcMethod(requestedRpcMethod, tag.id, usedRpcMethods) : null
    if (rpcMethod !== requestedRpcMethod) adjustedRpcMethods += 1
    return {
      ...tag,
      rpcMethod,
      componentType: importableComponentType(component, tag),
      componentProperties: exportComponentProperties(component),
    }
  })
  const exportedTagById = new Map(exportedTags.map(tag => [tag.id, tag]))
  const metadata = {
    format: 'scamatic-builder',
    version: NODE_RED_EXPORT_VERSION,
    project,
    tags: exportedTags,
    components,
  }
  const metadataText = JSON.stringify(metadata)
  if (utf8Size(metadataText) > NODE_RED_EXPORT_LIMITS.maxMetadataBytes) throw new Error('Project metadata exceeds the 1 MB Node-RED export limit.')

  nodes.push({ id: tabId, type: 'tab', label: project.name, disabled: false, info: `Generated from Scamatic Builder schema ${project.schemaVersion}.` })
  nodes.push({
    id: metadataId,
    type: 'comment',
    z: tabId,
    name: 'Scamatic Builder round-trip metadata',
    info: `${NODE_RED_EXPORT_MARKER}\n${metadataText}`,
    x: 210,
    y: 40,
    wires: [],
  })
  nodes.push({
    id: setupCommentId,
    type: 'comment',
    z: tabId,
    name: 'Setup required: configure ThingsBoard broker token and PLC endpoint before deploy',
    info: 'Credentials are intentionally excluded. Configure the MQTT broker username/device token in Node-RED. Tags without an exported PLC address are routed to clearly labeled TODO debug nodes.',
    x: 350,
    y: 80,
    wires: [],
  })

  const readableTags = exportedTags.filter(tag => tag.access !== 'write')
  const writableTags = exportedTags.filter(tag => tag.access !== 'read')
  const plcTags = exportedTags.filter(tag => tag.plcAddress)
  const dashboard = createDashboardNodes({ components, tagById: exportedTagById, tabId, id })
  const targetNodes = createCommandTargets({ writableTags, tabId, endpointId, id })
  const targetByTagId = new Map(targetNodes.map(item => [item.tagId, item.node.id]))
  for (const item of targetNodes) nodes.push(item.node)

  for (const item of dashboard.items) {
    const targetId = item.tagId ? targetByTagId.get(item.tagId) : null
    item.node.wires = targetId && item.commandOutput ? [[targetId]] : [[]]
    nodes.push(item.node)
  }
  nodes.push(...dashboard.extractors)
  nodes.push(...dashboard.configNodes)

  if (plcTags.length) {
    nodes.push(createS7Endpoint(endpointId, plcTags))
  }

  if (readableTags.length) {
    const formatterId = id('telemetry-formatter')
    const telemetryOutId = id('telemetry-out')
    const extractorIds = dashboard.extractors.map(node => node.id)
    const sourceTargets = [formatterId, ...extractorIds]
    const plcReadableTags = readableTags.filter(tag => tag.plcAddress)
    const templateReadableTags = readableTags.filter(tag => !tag.plcAddress)
    if (plcReadableTags.length) nodes.push(createS7Input(id('s7-input'), tabId, endpointId, sourceTargets))
    if (templateReadableTags.length) nodes.push(createTelemetryTemplate(id('telemetry-input-template'), tabId, sourceTargets))
    nodes.push({
      id: formatterId,
      type: 'function',
      z: tabId,
      name: 'Format Builder telemetry',
      func: telemetryFormatterFunction(readableTags),
      outputs: 1,
      timeout: 0,
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      x: 430,
      y: 160,
      wires: [[telemetryOutId]],
    })
    nodes.push(createMqttOut(telemetryOutId, tabId, brokerId, 'ThingsBoard telemetry', 'v1/devices/me/telemetry', 700, 160))
  }

  if (writableTags.length) {
    const rpcInId = id('rpc-input')
    const rpcRouterId = id('rpc-router')
    const rpcResponseId = id('rpc-response')
    nodes.push(createMqttIn(rpcInId, tabId, brokerId, rpcRouterId))
    nodes.push({
      id: rpcRouterId,
      type: 'function',
      z: tabId,
      name: 'Validate and route Builder RPC',
      func: rpcRouterFunction(writableTags),
      outputs: writableTags.length + 1,
      timeout: 0,
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      x: 430,
      y: 500,
      wires: [...writableTags.map(tag => [targetByTagId.get(tag.id)]), [rpcResponseId]],
    })
    nodes.push(createMqttOut(rpcResponseId, tabId, brokerId, 'ThingsBoard RPC response', '', 720, 540))
  }

  if (readableTags.length || writableTags.length) nodes.push(createMqttBroker(brokerId))

  const missingPlc = exportedTags.filter(tag => !tag.plcAddress).length
  if (missingPlc) warnings.push(`${missingPlc} tag${missingPlc === 1 ? '' : 's'} have no exported PLC address; connect their template or TODO nodes before deployment.`)
  const unsupportedComponents = components.filter(component => !DASHBOARD_COMPONENT_TYPES.has(component.type)).length
  if (unsupportedComponents) warnings.push(`${unsupportedComponents} component${unsupportedComponents === 1 ? '' : 's'} have no direct Node-RED Dashboard equivalent and are preserved only in round-trip metadata.`)
  if (components.some(component => component.type === 'chart' && component.tagIds.length > 1)) warnings.push('Multi-tag charts use one Dashboard chart with one extractor per readable tag.')
  if (adjustedRpcMethods) warnings.push(`${adjustedRpcMethods} duplicate RPC method${adjustedRpcMethods === 1 ? ' was' : 's were'} given deterministic suffixes so every command remains routable.`)
  warnings.push('ThingsBoard and PLC credentials are never included; configure them in Node-RED before deployment.')
  const setupComment = nodes.find(node => node.id === setupCommentId)
  setupComment.info = `Configure the MQTT broker username/device token and PLC endpoint before deploy.\n\nExport notes:\n${warnings.map(warning => `- ${warning}`).join('\n')}`

  if (nodes.length > NODE_RED_EXPORT_LIMITS.maxNodes) throw new Error(`Export would contain more than ${NODE_RED_EXPORT_LIMITS.maxNodes} Node-RED nodes.`)
  return {
    format: 'node-red',
    version: NODE_RED_EXPORT_VERSION,
    fileName: `${slugPart(project.slug || project.name) || 'scamatic-project'}-node-red-flow.json`,
    nodes,
    warnings: [...new Set(warnings)],
    stats: {
      nodes: nodes.length,
      tags: exportedTags.length,
      readableTags: readableTags.length,
      writableTags: writableTags.length,
      plcMappedTags: plcTags.length,
      dashboardNodes: dashboard.items.length,
      metadataOnlyComponents: unsupportedComponents,
      adjustedRpcMethods,
    },
  }
}

export function serializeNodeRedExport(result) {
  if (result?.format !== 'node-red' || !Array.isArray(result.nodes)) throw new Error('A valid Node-RED export result is required.')
  return `${JSON.stringify(result.nodes, null, 2)}\n`
}

function sanitizeProject(project = {}) {
  const name = safeText(project.name, 120) || 'Scamatic project'
  return {
    id: safeText(project.id, 200) || `project-${stableHash(name)}`,
    name,
    slug: safeText(project.slug, 120) || slugPart(name),
    schemaVersion: safeText(project.schemaVersion, 30),
    canvas: {
      width: finiteNumber(project.canvas?.width, 1920),
      height: finiteNumber(project.canvas?.height, 1080),
    },
  }
}

function sanitizeTag(tag, sourceTypes) {
  const id = safeText(tag?.id, 200)
  const path = safeText(tag?.path, 255)
  if (!id || !path || !DATA_TYPES.has(tag?.dataType) || !ACCESS_MODES.has(tag?.access)) return null
  const plcAddress = safePlcAddress(tag?.metadata?.plcAddress)
  return {
    id,
    name: safeText(tag.name, 255) || humanizeName(path),
    path,
    dataType: tag.dataType,
    access: tag.access,
    sourceType: sourceTypes.get(safeText(tag.sourceId, 200)) || 'mock',
    ...(plcAddress ? { plcAddress } : {}),
  }
}

function sanitizeComponent(component, tagById) {
  const id = safeText(component?.id, 200)
  const type = safeText(component?.type, 80)
  if (!id || !COMPONENT_REGISTRY[type]) return null
  const rawTagIds = type === 'chart' ? component?.binding?.tagIds : [component?.binding?.tagId]
  const tagIds = [...new Set((Array.isArray(rawTagIds) ? rawTagIds : []).map(value => safeText(value, 200)).filter(tagId => tagById.has(tagId)))]
  return {
    id,
    type,
    name: safeText(component.name, 255) || COMPONENT_REGISTRY[type].label,
    tagIds,
    visible: component.visible !== false,
    properties: exportComponentProperties(component),
  }
}

function exportComponentProperties(component) {
  const properties = component?.properties || {}
  const result = {}
  const label = safeText(properties.label || properties.text, 255)
  if (label) result.label = label
  for (const key of ['min', 'max', 'step']) if (Number.isFinite(Number(properties[key]))) result[key] = Number(properties[key])
  if (Number.isInteger(Number(properties.decimals))) result.decimals = Math.max(0, Math.min(8, Number(properties.decimals)))
  const suffix = safeText(properties.suffix, 40)
  if (suffix) result.suffix = suffix
  const rpcMethod = safeRpcMethod(properties.rpcMethod)
  if (rpcMethod) result.rpcMethod = rpcMethod
  const action = safeText(properties.action, 40)
  if (action && /^[a-z0-9-]+$/i.test(action)) result.action = action
  if (['boolean', 'number', 'string'].includes(typeof properties.payload)) result.payload = properties.payload
  return result
}

function firstComponentByTag(components) {
  const result = new Map()
  for (const component of components) {
    if (!DASHBOARD_COMPONENT_TYPES.has(component.type)) continue
    for (const tagId of component.tagIds) if (!result.has(tagId)) result.set(tagId, component)
  }
  return result
}

function importableComponentType(component, tag) {
  if (!component || !IMPORTABLE_COMPONENT_TYPES.has(component.type)) return null
  if (component.type === 'chart') return 'value-span'
  const allowed = COMPONENT_REGISTRY[component.type]?.allowedDataTypes || []
  return allowed.includes(tag.dataType) ? component.type : null
}

function createDashboardNodes({ components, tagById, tabId, id }) {
  const visible = components.filter(component => component.visible && DASHBOARD_COMPONENT_TYPES.has(component.type) && component.tagIds.length)
  if (!visible.length) return { items: [], extractors: [], configNodes: [] }
  const uiTabId = id('dashboard-tab')
  const uiGroupId = id('dashboard-group')
  const items = []
  const extractors = []
  let order = 1
  for (const component of visible) {
    const tags = component.tagIds.map(tagId => tagById.get(tagId)).filter(Boolean)
    if (!tags.length) continue
    const nodeId = id(`dashboard:${component.id}`)
    const node = dashboardNode(component, tags, { id: nodeId, tabId, groupId: uiGroupId, order })
    if (!node) continue
    const commandTag = tags.find(tag => tag.access !== 'read')
    items.push({ node, tagId: commandTag?.id || tags[0].id, commandOutput: Boolean(commandTag && ['control-button', 'tuning-slider', 'operation-shifter'].includes(component.type)) })
    for (const tag of tags.filter(item => item.access !== 'write')) {
      const extractorId = id(`dashboard-extractor:${component.id}:${tag.id}`)
      extractors.push({
        id: extractorId,
        type: 'function',
        z: tabId,
        name: `Read ${tag.name}`,
        func: `const source = msg.payload || {};\nmsg.topic = ${JSON.stringify(tag.path)};\nmsg.payload = source[${JSON.stringify(tag.path)}];\nreturn msg;`,
        outputs: 1,
        timeout: 0,
        noerr: 0,
        initialize: '',
        finalize: '',
        libs: [],
        x: 430,
        y: 220 + extractors.length * 42,
        wires: [[nodeId]],
      })
    }
    order += 1
  }
  return {
    items,
    extractors,
    configNodes: [
      { id: uiTabId, type: 'ui_tab', name: safeText(components[0]?.name, 120) || 'Scamatic', icon: 'dashboard', disabled: false, hidden: false },
      { id: uiGroupId, type: 'ui_group', name: 'Builder components', tab: uiTabId, order: 1, disp: true, width: '12', collapse: false, className: '' },
    ],
  }
}

function dashboardNode(component, tags, context) {
  const tag = tags[0]
  const common = {
    id: context.id,
    z: context.tabId,
    group: context.groupId,
    order: context.order,
    width: 6,
    height: 2,
    name: component.name,
    label: component.properties.label || component.name,
    topic: tag.path,
    className: '',
    x: 700,
    y: 220 + (context.order - 1) * 42,
    wires: [[]],
  }
  if (component.type === 'indicator-lamp') return { ...common, type: 'ui_text', format: '{{msg.payload}}', layout: 'row-spread' }
  if (component.type === 'value-span') return tag.dataType === 'number'
    ? { ...common, type: 'ui_gauge', gtype: 'gage', title: common.label, format: `{{value}}${component.properties.suffix || ''}`, min: component.properties.min ?? 0, max: component.properties.max ?? 100, colors: ['#00b500', '#e6e600', '#ca3838'], seg1: '', seg2: '' }
    : { ...common, type: 'ui_text', format: '{{msg.payload}}', layout: 'row-spread' }
  if (component.type === 'control-button') return tag.dataType === 'boolean' && tag.access !== 'write'
    ? { ...common, type: 'ui_switch', passthru: false, decouple: 'false', onvalue: 'true', onvalueType: 'bool', offvalue: 'false', offvalueType: 'bool', animate: false }
    : { ...common, type: 'ui_button', payload: String(component.properties.payload ?? true), payloadType: typeof component.properties.payload === 'number' ? 'num' : typeof component.properties.payload === 'boolean' ? 'bool' : 'str', color: '', bgcolor: '', icon: '' }
  if (component.type === 'tuning-slider') return { ...common, type: 'ui_slider', passthru: false, outs: 'all', min: component.properties.min ?? 0, max: component.properties.max ?? 100, step: component.properties.step ?? 1, thumbLabel: true, showTicks: false }
  if (component.type === 'operation-shifter') return { ...common, type: 'ui_dropdown', place: 'Select mode', passthru: false, multiple: 'false', options: [{ label: 'MANUAL', value: 'MANUAL', type: 'str' }, { label: 'AUTO', value: 'AUTO', type: 'str' }, { label: 'RESET', value: 'RESET', type: 'str' }] }
  if (component.type === 'chart') return { ...common, type: 'ui_chart', height: 4, chartType: 'line', legend: 'false', xformat: 'HH:mm:ss', interpolate: 'linear', nodata: 'No data', dot: false, ymin: '', ymax: '', removeOlder: '1', removeOlderPoints: '', removeOlderUnit: '3600', cutout: 0, useOneColor: false, useUTC: false, colors: ['#1f77b4', '#aec7e8', '#ff7f0e', '#2ca02c', '#d62728'] }
  return null
}

function createCommandTargets({ writableTags, tabId, endpointId, id }) {
  return writableTags.map((tag, index) => ({
    tagId: tag.id,
    node: tag.plcAddress
      ? { id: id(`s7-output:${tag.id}`), type: 's7 out', z: tabId, endpoint: endpointId, variable: tag.path, name: `Write ${tag.name}`, x: 720, y: 620 + index * 40, wires: [] }
      : { id: id(`todo-output:${tag.id}`), type: 'debug', z: tabId, name: `TODO connect write: ${tag.name}`, active: true, tosidebar: true, console: false, tostatus: false, complete: 'payload', targetType: 'msg', statusVal: '', statusType: 'auto', x: 750, y: 620 + index * 40, wires: [] },
  }))
}

function createS7Endpoint(id, tags) {
  return {
    id,
    type: 's7 endpoint',
    transport: 'iso-on-tcp',
    address: '${PLC_HOST}',
    port: '102',
    rack: '0',
    slot: '1',
    localtsaphi: '01',
    localtsaplo: '00',
    remotetsaphi: '01',
    remotetsaplo: '00',
    connmode: 'rack-slot',
    adapter: '',
    busaddr: '2',
    cyctime: '1000',
    timeout: '2000',
    name: 'Scamatic PLC (configure endpoint)',
    vartable: tags.map(tag => ({ addr: tag.plcAddress, name: tag.path })),
  }
}

function createS7Input(id, tabId, endpointId, targets) {
  return { id, type: 's7 in', z: tabId, endpoint: endpointId, mode: 'all', variable: '', diff: true, name: 'Read PLC tags', x: 150, y: 160, wires: [targets] }
}

function createTelemetryTemplate(id, tabId, targets) {
  return {
    id,
    type: 'inject',
    z: tabId,
    name: 'Telemetry input template (wire your source)',
    props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
    repeat: '',
    crontab: '',
    once: false,
    onceDelay: 0.1,
    topic: '',
    payload: '{}',
    payloadType: 'json',
    x: 190,
    y: 160,
    wires: [targets],
  }
}

function createMqttBroker(id) {
  return {
    id,
    type: 'mqtt-broker',
    name: 'ThingsBoard (configure device token)',
    broker: '${THINGSBOARD_MQTT_HOST}',
    port: '1883',
    clientid: '',
    autoConnect: true,
    usetls: false,
    protocolVersion: '4',
    keepalive: '60',
    cleansession: true,
    autoUnsubscribe: true,
    birthTopic: '',
    birthQos: '0',
    birthPayload: '',
    birthMsg: {},
    closeTopic: '',
    closeQos: '0',
    closePayload: '',
    closeMsg: {},
    willTopic: '',
    willQos: '0',
    willPayload: '',
    willMsg: {},
  }
}

function createMqttOut(id, tabId, brokerId, name, topic, x, y) {
  return { id, type: 'mqtt out', z: tabId, name, topic, qos: '1', retain: 'false', respTopic: '', contentType: '', userProps: '', correl: '', expiry: '', broker: brokerId, x, y, wires: [] }
}

function createMqttIn(id, tabId, brokerId, routerId) {
  return { id, type: 'mqtt in', z: tabId, name: 'ThingsBoard RPC requests', topic: 'v1/devices/me/rpc/request/+', qos: '1', datatype: 'json', broker: brokerId, nl: false, rap: true, rh: 0, inputs: 0, x: 170, y: 500, wires: [[routerId]] }
}

function telemetryFormatterFunction(tags) {
  const assignments = tags.map(tag => `msg.payload[${JSON.stringify(tag.path)}] = input[${JSON.stringify(tag.path)}];`).join('\n')
  return `const input = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};\nmsg.payload = {};\n${assignments}\nreturn msg;`
}

function rpcRouterFunction(tags) {
  const cases = tags.map((tag, index) => `case ${JSON.stringify(tag.rpcMethod)}:\n    outputIndex = ${index}; dataType = ${JSON.stringify(tag.dataType)}; targetPath = ${JSON.stringify(tag.path)}; break;`).join('\n  ')
  const responseIndex = tags.length
  return `const match = /^v1\\/devices\\/me\\/rpc\\/request\\/([^/]+)$/.exec(msg.topic || '');
const request = msg.payload || {};
let outputIndex = -1;
let dataType = '';
let targetPath = '';
switch (request.method) {
  ${cases}
  default: break;
}
let value = request.params;
let error = match ? '' : 'Malformed RPC topic';
if (!error && outputIndex < 0) error = 'Unsupported RPC method';
if (!error && dataType === 'boolean') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (normalized === true || normalized === 1 || normalized === '1' || normalized === 'true') value = true;
  else if (normalized === false || normalized === 0 || normalized === '0' || normalized === 'false') value = false;
  else error = 'Boolean params required';
}
if (!error && dataType === 'number') {
  value = Number(value);
  if (!Number.isFinite(value)) error = 'Finite number params required';
}
if (!error && ['string', 'enum', 'datetime'].includes(dataType)) value = String(value ?? '');
const outputs = Array(${tags.length + 1}).fill(null);
if (!error) outputs[outputIndex] = { ...msg, topic: targetPath, payload: value };
if (match) outputs[${responseIndex}] = {
  ...msg,
  topic: \`v1/devices/me/rpc/response/\${match[1]}\`,
  qos: 1,
  retain: false,
  payload: error ? { ok: false, accepted: false, method: String(request.method || ''), error } : { ok: true, accepted: true, method: String(request.method || ''), value }
};
return outputs;`
}

function rpcMethodForTag(tag, component) {
  const explicit = safeRpcMethod(component?.properties?.rpcMethod)
  return explicit || `set${pascalPart(tag.path) || 'Value'}`.slice(0, 100)
}

function uniqueRpcMethod(method, seed, used) {
  if (!used.has(method)) {
    used.add(method)
    return method
  }
  let suffix = `_${stableHash(seed)}`
  let candidate = `${method.slice(0, 100 - suffix.length)}${suffix}`
  let counter = 2
  while (used.has(candidate)) {
    suffix = `_${stableHash(seed).slice(0, 6)}${counter++}`
    candidate = `${method.slice(0, 100 - suffix.length)}${suffix}`
  }
  used.add(candidate)
  return candidate
}

function safeRpcMethod(value) {
  const text = safeText(value, 100)
  return /^[a-zA-Z0-9_.:-]{1,100}$/.test(text) ? text : ''
}

function safePlcAddress(value) {
  const text = safeText(value, 100).toUpperCase()
  return /^(?:[IQM](?:X?\d+\.\d+|[BWD]\d+)|DB\d+\.DB(?:X\d+\.\d+|[BWD]\d+))$/.test(text) ? text : ''
}

function safeSourceType(value) {
  return value === 'thingsboard' ? 'thingsboard' : 'mock'
}

function deterministicNodeId(seed, used) {
  let suffix = 0
  let candidate
  do {
    const key = suffix ? `${seed}:${suffix}` : seed
    candidate = `${stableHash(key)}${stableHash(`node-red:${key}`)}`
    suffix += 1
  } while (used.has(candidate))
  used.add(candidate)
  return candidate
}

function stableHash(value) {
  const input = String(value)
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function humanizeName(value) {
  return safeText(value, 255).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim() || 'Exported tag'
}

function slugPart(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

function pascalPart(value) {
  return String(value || '').split(/[^a-zA-Z0-9]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('').replace(/^[^a-zA-Z]+/, '')
}

function safeText(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function finiteNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

function utf8Size(value) {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(value).byteLength : value.length
}
