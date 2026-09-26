import { runtimeWorkerMode } from '../../shared/runtime-worker-mode.js'

export async function loadRuntimeReconciliationInputs({
  connectors = [],
  environmentRef = 'staging',
  findEnvironments,
  findProjects,
  findVersions,
  findDrafts,
  findActiveSessionProjectIds,
  selectRuntimeSchema,
} = {}) {
  const records = Array.isArray(connectors) ? connectors.filter(Boolean) : []
  if (!records.length) return { items: [], activeProjectIds: new Set() }
  for (const dependency of [findEnvironments, findProjects, findVersions, findDrafts, findActiveSessionProjectIds, selectRuntimeSchema]) {
    if (typeof dependency !== 'function') throw new TypeError('Runtime reconciliation dependencies must be functions.')
  }

  const connectorIds = unique(records.map(item => item._id || item.id))
  const environments = await findEnvironments(connectorIds, environmentRef)
  const environmentByConnector = indexBy(environments, item => item.connectorId)
  const projectIds = unique(records
    .filter(connector => environmentByConnector.has(key(connector._id || connector.id)))
    .map(connector => connector.projectId))
  const projects = await findProjects(projectIds)
  const projectById = indexBy(projects, item => item._id || item.id)
  const versionIds = unique(projects.map(project => project.activeVersionId).filter(Boolean))
  const versions = await findVersions(versionIds)
  const versionById = indexBy(versions, item => item._id || item.id)

  const preliminary = records.map(connector => {
    const environment = environmentByConnector.get(key(connector._id || connector.id)) || null
    const candidateProject = environment ? projectById.get(key(connector.projectId)) || null : null
    const project = candidateProject && key(candidateProject.workspaceId) === key(connector.workspaceId)
      ? candidateProject
      : null
    const version = project?.activeVersionId ? versionById.get(key(project.activeVersionId)) || null : null
    const selection = project
      ? selectRuntimeSchema({ connector, environmentRef, publishedVersion: version })
      : null
    return { connector, environment, project, version, draft: null, selection }
  })

  const draftProjectIds = unique(preliminary
    .filter(item => item.project && !item.selection)
    .map(item => item.project._id || item.project.id))
  const drafts = draftProjectIds.length ? await findDrafts(draftProjectIds) : []
  const draftById = indexBy(drafts, item => item._id || item.id)
  const items = preliminary.map(item => {
    if (!item.project || item.selection) return item
    const draft = draftById.get(key(item.project._id || item.project.id)) || null
    const selection = selectRuntimeSchema({
      connector: item.connector,
      environmentRef,
      publishedVersion: item.version,
      draft,
    })
    return { ...item, draft, selection }
  })

  const sessionProjectIds = unique(items
    .filter(item => item.project && item.selection && sessionCanChangeDecision(item.project, item.selection))
    .map(item => item.project._id || item.project.id))
  const active = sessionProjectIds.length
    ? await findActiveSessionProjectIds(sessionProjectIds)
    : []
  return {
    items,
    activeProjectIds: new Set((Array.isArray(active) ? active : []).map(key).filter(Boolean)),
  }
}

function sessionCanChangeDecision(project, selection) {
  const mode = runtimeWorkerMode(project)
  return mode === 'on-demand' || (mode === 'smart' && selection?.mode === 'bootstrap')
}

function indexBy(records, identity) {
  const index = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    const id = key(identity(record))
    if (id && !index.has(id)) index.set(id, record)
  }
  return index
}

function unique(values) {
  return [...new Set(values.map(key).filter(Boolean))]
}

function key(value) {
  return String(value || '').trim()
}
