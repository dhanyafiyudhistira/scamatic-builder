import { createHash } from 'node:crypto'
import { COMPONENT_REGISTRY } from '../shared/component-registry.js'
import { validateProjectSchema } from '../shared/project-schema.js'
import { MARKUP_PROPERTY_FIELDS, MARKUP_TYPE } from '../shared/markup-stroke.js'
import { isIotDashboardProject, projectRequiresSchematicAsset, validProjectType } from '../shared/project-type.js'
import { runtimeProfile } from '../shared/runtime-profile.js'
import { hostedRuntimePolicy } from '../shared/hosted-runtime-policy.js'
import { prepareDesignAsset, referencedDesignAssetIds } from '../api/_lib/design-assets.js'
import { sanitizeSvg } from '../api/_lib/svg.js'

export const RUNTIME_PACKAGE_FORMAT = 'scamatic-runtime-bundle/v1'
export const RUNTIME_FILES_FORMAT = 'scamatic-runtime-files/v1'
export const RUNTIME_PACKAGE_ENGINE = '0.2.24'
export const MAX_EXPORT_ZIP_BYTES = 3 * 1024 * 1024
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const digestJson = value => sha256(JSON.stringify(value))
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
const propertyKeys = new Set(Object.values(COMPONENT_REGISTRY).flatMap(value => Object.keys(value.defaultProperties)))
const markupPropertyKeys = new Set(MARKUP_PROPERTY_FIELDS)
for (const key of ['feedbackTagId', 'expectedFeedbackValue', 'rpcMethod', 'ackMode', 'ackTimeoutMs', 'confirmation', 'requiredRole', 'rangeMode', 'unitMode', 'scale', 'offset', 'theme', 'themeMode', 'dashboardTheme']) propertyKeys.add(key)
const forbidden = /^(?:__proto__|constructor|prototype|password|passwordHash|pinHash|jwt|token|accessToken|refreshToken|deviceToken|secret|credentials|mongoUri|masterKey|payloadCiphertext|wrappedKey)$/i
const deploymentIdentity = schema => `${isIotDashboardProject(schema) ? 'iot' : 'scada'}-${sha256(schema.project.id).slice(0, 24)}`
const connectorSources = schema => runtimeProfile(schema) === 'simulation' ? [] : schema.dataSources.filter(source => source.type === 'thingsboard')

function safeData(value, depth = 0) {
  if (depth > 24) throw new Error('Runtime data nesting exceeds the export limit.')
  if (typeof value === 'string') {
    if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|mongodb(?:\+srv)?:\/\//i.test(value) || /https?:\/\/[^/\s]*@/.test(value)) {
      throw new Error('Runtime data contains credential-like content. Remove it from the project before exporting.')
    }
    return value
  }
  if (Array.isArray(value)) return value.map(item => safeData(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (forbidden.test(key)) throw new Error('Runtime data contains a protected credential field.')
    return [key, safeData(item, depth + 1)]
  }))
  return value
}

export function exportRuntimeSchema(input) {
  if (!validProjectType(input?.project?.projectType)) throw new Error('Hosted runtime requires a SCADA or IoT Dashboard project.')
  const schema = {
    schemaVersion: input.schemaVersion,
    project: safeData(pick(input.project, ['id', 'name', 'slug', 'projectType', 'runtimeProfile', 'canvas', 'svgAssetId', 'dashboardLayout'])),
    dataSources: (input.dataSources || []).map(source => safeData(pick(source, ['id', 'type', 'connectorRef', 'environmentRef']))),
    tags: (input.tags || []).map(tag => safeData(pick(tag, ['id', 'name', 'sourceId', 'path', 'dataType', 'access', 'unit', 'enumValues', 'staleAfterMs', 'freshnessMode', 'adaptiveFreshness', 'engineering', 'writeConstraints', 'numberFormat', 'initialValue', 'alarmRule']))),
    components: (input.components || []).map(component => {
      const permitted = component.type === MARKUP_TYPE ? markupPropertyKeys : propertyKeys
      for (const key of Object.keys(component.properties || {})) {
        if (!permitted.has(key)) throw new Error(`Component ${component.name || component.id} has an unsupported export property: ${key}.`)
      }
      return safeData(pick(component, ['id', 'type', 'name', 'position', 'responsivePositions', 'zIndex', 'visible', 'locked', 'binding', 'properties', 'children']))
    }),
  }
  if (schema.dataSources.some(source => !['thingsboard', 'mock'].includes(source.type))) throw new Error('Hosted trial supports ThingsBoard and mock sources only.')
  const errors = validateProjectSchema(schema, { requireAsset: projectRequiresSchematicAsset(schema) }).filter(issue => issue.severity === 'error')
  if (errors.length) throw Object.assign(new Error(`Runtime export validation failed: ${errors[0].message}`), { issues: errors })
  return schema
}

function verifiedPublishedSchema(version) {
  if (digestJson(version.schema) === version.checksum) return version.schema
  // Older Mongoose writes minimized the Builder's empty component metadata.
  // Reconstruct only that known field, in its original position before children.
  // The original publication checksum must match exactly; never replace it or
  // persist a guessed snapshot back into the user's database.
  if (Array.isArray(version.schema?.components)) {
    const restored = structuredClone(version.schema)
    restored.components = restored.components.map(component => {
      if (!component || typeof component !== 'object' || Object.hasOwn(component, 'metadata')) return component
      const entries = Object.entries(component).flatMap(([key, value]) => key === 'children' ? [['metadata', {}], [key, value]] : [[key, value]])
      if (!Object.hasOwn(component, 'children')) entries.push(['metadata', {}])
      return Object.fromEntries(entries)
    })
    if (digestJson(restored) === version.checksum) return restored
  }
  throw Object.assign(new Error('Published schema checksum does not match. Save and publish a new version with the latest Builder, then export again.'), { code: 'PUBLISHED_SCHEMA_CHECKSUM_MISMATCH' })
}

export function createDeployment({ project, version, assets = [], connectors = [], engineVersion = RUNTIME_PACKAGE_ENGINE, generatedAt = new Date().toISOString() }) {
  if (!version || String(version.projectId) !== String(project._id || project.id)) throw new Error('Published project version is unavailable.')
  const schema = exportRuntimeSchema(verifiedPublishedSchema(version))
  const projectId = String(project._id || project.id)
  if (schema.project.id !== projectId) throw new Error('Published schema project identity does not match.')
  if (schema.project.svgAssetId && (version.assetId !== schema.project.svgAssetId || !version.assetChecksum)) throw new Error('Published schematic identity or checksum is unavailable.')
  const requiredAssets = new Set([...referencedDesignAssetIds(schema), schema.project.svgAssetId].filter(Boolean))
  if (requiredAssets.size > 64) throw new Error('Hosted trial supports at most 64 published assets.')
  const exportedAssets = [...requiredAssets].map(id => {
    const asset = assets.find(item => String(item._id || item.id) === id && String(item.projectId) === projectId)
    if (!asset || sha256(asset.content) !== asset.checksum) throw new Error('A published asset is missing or has an invalid checksum.')
    if (id === schema.project.svgAssetId && asset.kind !== 'svg') throw new Error('Published schematic must be a sanitized SVG asset.')
    const prepared = asset.kind === 'svg'
      ? (() => { const clean = sanitizeSvg(asset.content); return { kind: 'svg', content: clean.svg, checksum: sha256(clean.svg), byteLength: clean.byteLength, metadata: {} } })()
      : prepareDesignAsset({ fileName: asset.metadata?.fileName, mimeType: asset.metadata?.mimeType, content: asset.content })
    return { _id: id, projectId, ...prepared }
  })
  if (version.assetChecksum && exportedAssets.find(asset => asset._id === version.assetId)?.checksum !== version.assetChecksum) throw new Error('Published schematic checksum does not match.')
  const exportedConnectors = connectorSources(schema).map(source => {
    const connector = connectors.find(item => item.id === source.connectorRef && item.environmentRef === (source.environmentRef || 'staging'))
    if (!connector) throw new Error('A published ThingsBoard connector is unavailable.')
    const config = safeData(pick(connector.config, ['serverUrl', 'deviceId']))
    const url = new URL(config.serverUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !config.deviceId) throw new Error('ThingsBoard export requires an HTTPS endpoint without credentials/query and a selected device.')
    return { id: source.connectorRef, environmentRef: source.environmentRef || 'staging', config }
  })
  const deploymentId = deploymentIdentity(schema)
  const payload = {
    project: { id: projectId, workspaceId: `hosted-${deploymentId}`, name: schema.project.name, slug: schema.project.slug, projectType: schema.project.projectType, pinRequired: Boolean(project.security?.pinEnabled) },
    version: { id: String(version._id || version.id), number: version.version, schema, checksum: digestJson(schema), sourceChecksum: version.checksum },
    assets: exportedAssets,
    connectors: [...new Map(exportedConnectors.map(connector => [`${connector.id}:${connector.environmentRef}`, connector])).values()],
  }
  const deployment = { format: RUNTIME_PACKAGE_FORMAT, engineVersion, deploymentId, generatedAt, policy: hostedRuntimePolicy(schema), payload, payloadChecksum: digestJson(payload) }
  verifyDeployment(deployment)
  return deployment
}

export function verifyDeployment(deployment) {
  if (deployment?.format !== RUNTIME_PACKAGE_FORMAT || deployment.engineVersion !== RUNTIME_PACKAGE_ENGINE || !['monitor-only', 'simulation'].includes(deployment.policy)) throw new Error('Runtime package format or engine is unsupported.')
  if (digestJson(deployment.payload) !== deployment.payloadChecksum) throw new Error('Runtime package checksum does not match.')
  if (Buffer.byteLength(JSON.stringify(deployment.payload)) > 16 * 1024 * 1024) throw new Error('Runtime payload exceeds the 16 MiB trial limit.')
  const { project, version, assets, connectors } = deployment.payload
  if (deployment.policy !== hostedRuntimePolicy(version.schema)) throw new Error('Runtime deployment policy does not match the published profile.')
  if (!version.id || !Number.isInteger(version.number) || version.number < 1 || project.id !== version.schema?.project?.id || project.slug !== version.schema?.project?.slug || project.projectType !== version.schema?.project?.projectType) throw new Error('Runtime project/version identity is invalid.')
  if (deployment.deploymentId !== deploymentIdentity(version.schema) || project.workspaceId !== `hosted-${deployment.deploymentId}`) throw new Error('Runtime deployment identity is invalid.')
  if (digestJson(exportRuntimeSchema(version.schema)) !== version.checksum || digestJson(version.schema) !== version.checksum) throw new Error('Runtime schema is invalid or has changed.')
  const required = new Set([...referencedDesignAssetIds(version.schema), version.schema.project.svgAssetId].filter(Boolean))
  if (required.size !== assets.length || new Set(assets.map(asset => asset._id)).size !== assets.length) throw new Error('Runtime asset inventory is invalid.')
  for (const asset of assets) {
    if (!required.has(asset._id) || asset.projectId !== project.id || sha256(asset.content) !== asset.checksum) throw new Error('Runtime asset integrity check failed.')
    if (asset._id === version.schema.project.svgAssetId && asset.kind !== 'svg') throw new Error('Runtime schematic must be a sanitized SVG asset.')
    const prepared = asset.kind === 'svg'
      ? (() => { const clean = sanitizeSvg(asset.content); return { content: clean.svg, byteLength: clean.byteLength } })()
      : asset.kind === 'design-image' ? prepareDesignAsset({ fileName: asset.metadata?.fileName, mimeType: asset.metadata?.mimeType, content: asset.content }) : null
    if (!prepared || prepared.content !== asset.content || prepared.byteLength !== asset.byteLength) throw new Error('Runtime asset format is invalid.')
  }
  const requiredConnectors = new Set(connectorSources(version.schema).map(source => `${source.connectorRef}:${source.environmentRef || 'staging'}`))
  if (connectors.length !== requiredConnectors.size || new Set(connectors.map(connector => `${connector.id}:${connector.environmentRef}`)).size !== requiredConnectors.size) throw new Error('Runtime connector inventory is invalid.')
  for (const source of connectorSources(version.schema)) {
    const connector = connectors.find(item => item.id === source.connectorRef && item.environmentRef === (source.environmentRef || 'staging'))
    if (!connector || Object.keys(connector.config).some(key => !['serverUrl', 'deviceId'].includes(key))) throw new Error('Runtime connector inventory is invalid.')
    safeData(connector.config)
    const url = new URL(connector.config.serverUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !connector.config.deviceId) throw new Error('Runtime connector target is invalid.')
  }
  return deployment
}
