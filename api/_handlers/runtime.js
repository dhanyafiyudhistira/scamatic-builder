import { connectMongo } from '../_lib/mongo.js'
import { CommandEvent, Project, ProjectVersion, ScadaAsset, TagValueSnapshot } from '../_lib/models.js'
import { requirePrincipal } from '../_lib/auth.js'
import { PERMISSIONS, requireProjectPermission } from '../_lib/authorization.js'
import { initialMockValue } from '../../shared/runtime-evaluator.js'
import { runtimeChartHistoryRequest } from '../../shared/runtime-chart-history.js'
import { readChartTelemetryHistory } from '../_lib/chart-telemetry-store.js'
import { loadWorkspaceChartStorage } from '../_lib/chart-storage-configuration.js'
import { runtimeProfileMetadata, runtimeUsesLiveTelemetry } from '../../shared/runtime-profile.js'
import { simulationCommandState } from '../../shared/simulation-command-state.js'
import { DESIGN_IMAGE_TYPE, publicDesignAssets, referencedDesignAssetIds } from '../_lib/design-assets.js'

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  }
  try {
    await connectMongo()
    const slug = String(req.query?.slug || '')
    const project = await Project.findOne({ workspaceId: principal.workspaceId, slug })
    if (!project || !(await requireProjectPermission(principal, res, project, PERMISSIONS.RUNTIME_VIEW))) return
    if (!project.activeVersionId) return res.status(409).json({ error: 'Project has not been published.', code: 'NOT_PUBLISHED' })
    const version = await ProjectVersion.findById(project.activeVersionId).lean()
    if (!version) return res.status(409).json({ error: 'Active published version is unavailable.', code: 'VERSION_MISSING' })
    const assetId = version.assetId || version.schema?.project?.svgAssetId
    const asset = await ScadaAsset.findOne({ _id: assetId, projectId: project.id }).lean()
    if (!asset) return res.status(409).json({ error: 'Published SVG asset is unavailable.', code: 'ASSET_MISSING' })
    if (version.assetChecksum && asset.checksum !== version.assetChecksum) return res.status(409).json({ error: 'Published asset integrity check failed.', code: 'ASSET_MISMATCH' })
    const designAssetIds = referencedDesignAssetIds(version.schema)
    const designAssetRecords = designAssetIds.length
      ? await ScadaAsset.find({ _id: { $in: designAssetIds }, projectId: project.id, kind: DESIGN_IMAGE_TYPE }).select({ content: 0 }).lean()
      : []
    if (designAssetRecords.length !== designAssetIds.length) return res.status(409).json({ error: 'A published design element is unavailable.', code: 'DESIGN_ASSET_MISSING' })
    const profile = runtimeProfileMetadata(version.schema)
    const [snapshots, recentSimulationCommands] = await Promise.all([
      TagValueSnapshot.find({ workspaceId: principal.workspaceId, projectId: project.id }).lean(),
      profile.id === 'simulation'
        ? CommandEvent.find({
            workspaceId: principal.workspaceId,
            projectId: project.id,
            versionId: version._id,
            executionMode: 'mock',
            status: 'acknowledged',
          }).sort({ createdAt: -1 }).limit(200).lean()
        : [],
    ])
    const byTag = new Map(snapshots.map(item => [item.tagId, item]))
    const restoredCommandsByTag = simulationCommandState(version.schema, recentSimulationCommands)
    const simulationTargets = simulationCommandTargets(version.schema, recentSimulationCommands)
    const liveTelemetry = runtimeUsesLiveTelemetry(version.schema)
    const values = Object.fromEntries((version.schema.tags || []).map(tag => {
      const source = version.schema.dataSources?.find(item => item.id === tag.sourceId)
      const snapshot = byTag.get(tag.id)
      // Simulation Bridge snapshots are authoritative across a browser reload as
      // well. Ignoring them here would replace active outputs with type defaults.
      if (source?.type !== 'mock' && snapshot) return [tag.id, { value: snapshot.value, timestamp: snapshot.sourceTimestamp, receivedAt: snapshot.receivedAt, quality: snapshot.quality, sequence: snapshot.sequence }]
      const restored = restoredCommandsByTag.get(tag.id)
      if (restored) return [tag.id, restored]
      return [tag.id, { value: initialMockValue(tag), timestamp: new Date().toISOString(), quality: liveTelemetry && source?.type !== 'mock' ? 'disconnected' : 'good', sequence: 0 }]
    }))
    let chartStorage
    let chartConfigurationError = false
    try {
      chartStorage = await loadWorkspaceChartStorage(principal.workspaceId)
    } catch (configurationError) {
      chartStorage = await loadWorkspaceChartStorage(principal.workspaceId, { environment: {}, allowEnvironmentFallback: false })
      chartConfigurationError = true
      console.error(JSON.stringify({ level: 'warn', event: 'chart.storage.configuration.invalid', errorCode: configurationError?.code || 'CHART_STORAGE_CONFIGURATION' }))
    }
    const chartConfig = chartStorage.config
    const historyRequest = runtimeChartHistoryRequest(version.schema, { maxBootstrapPoints: chartConfig.maxBootstrapPoints })
    let history = {}
    let historyStorage = {
      enabled: chartStorage.public.enabled,
      engine: chartStorage.public.engine,
      isolatedCluster: chartStorage.public.isolatedCluster,
      retentionDays: chartStorage.public.retentionDays,
      state: chartConfigurationError ? 'degraded' : chartConfig.enabled ? 'configured' : 'disabled',
    }
    if (chartConfig.enabled && historyRequest) {
      try {
        history = await readChartTelemetryHistory({
          workspaceId: principal.workspaceId,
          projectId: project.id,
          ...historyRequest,
        }, { config: chartConfig })
        historyStorage = { ...historyStorage, state: 'ready' }
      } catch (historyError) {
        historyStorage = { ...historyStorage, state: 'degraded' }
        console.error(JSON.stringify({ level: 'warn', event: 'chart.history.bootstrap.failed', projectId: project.id, errorCode: historyError?.code || 'CHART_STORAGE_UNAVAILABLE' }))
      }
    }
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({ projectId: project.id, schema: version.schema, svg: asset.content, designAssets: publicDesignAssets(designAssetRecords), versionId: version._id, version: version.version, checksum: version.checksum, environment: version.environmentRef || 'mock', profile, values, simulationTargets, history, historyStorage })
  } catch {
    return res.status(500).json({ error: 'Unable to load published runtime.' })
  }
}

function simulationCommandTargets(schema, commands) {
  const components = new Map((schema?.components || []).map(component => [component.id, component]))
  const targets = {}
  for (const command of commands || []) {
    const component = components.get(command.componentId)
    if (component && /reset/i.test(`${component.properties?.rpcMethod || ''} ${component.name || ''}`)) break
    if (component?.type !== 'tuning-slider' || command.resultSummary?.value == null) continue
    const targetTagId = component.properties?.feedbackTagId || component.binding?.tagId
    if (targetTagId && targets[targetTagId] == null) targets[targetTagId] = command.resultSummary.value
  }
  return targets
}
