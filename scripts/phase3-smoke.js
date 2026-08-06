import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createComponentInstance } from '../shared/component-registry.js'

const baseUrl = process.env.SMOKE_BASE_URL || 'http://localhost:3001'
const email = process.env.SCADA_ADMIN_EMAIL || 'admin@scada.local'
const password = process.env.SCADA_ADMIN_PASSWORD || 'admin'
let cookies = ''
let csrf = ''
let projectId = null
let projectSlug = null
const keepProject = process.env.SMOKE_KEEP === '1'

async function request(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'X-Request-ID': randomUUID(),
      ...(cookies ? { Cookie: cookies } : {}),
      ...(!['GET', 'HEAD'].includes(method) && csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const setCookies = response.headers.getSetCookie?.() || []
  if (setCookies.length) {
    cookies = setCookies.map(value => value.split(';')[0]).join('; ')
    csrf = decodeURIComponent(setCookies.find(value => value.startsWith('scada_csrf='))?.split(';')[0].split('=')[1] || '')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${data.error || 'Unknown error'} ${data.code || ''}`)
  return data
}

try {
  await request('/api/auth', { method: 'POST', body: JSON.stringify({ email, password }) })
  const existingProjects = await request('/api/projects')
  for (const stale of existingProjects.projects.filter(project => project.slug.startsWith('phase3-smoke-'))) {
    await request(`/api/projects?id=${stale.id}`, { method: 'DELETE', body: JSON.stringify({ projectId: stale.id, confirmSlug: stale.slug }) })
  }
  const slug = `phase3-smoke-${Date.now()}`
  projectSlug = slug
  const created = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Phase 3 Smoke', slug, width: 1280, height: 720 }) })
  projectId = created.project.id
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#0b151e"/><path d="M80 360h1120" stroke="#446270" stroke-width="8"/></svg>'
  const uploaded = await request('/api/svg', { method: 'POST', body: JSON.stringify({ projectId, svg }) })
  const loaded = await request(`/api/draft?projectId=${projectId}`)
  const tag = { id: 'valve.command', name: 'Valve Command', path: 'valve.command', dataType: 'boolean', access: 'read-write', sourceId: 'source_mock', staleAfterMs: 10000 }
  const component = createComponentInstance('control-button', { id: 'command-button', canvas: loaded.schema.project.canvas, tagId: tag.id, index: 0 })
  component.properties.label = 'OPEN VALVE'
  component.properties.confirmation = 'single'
  const schema = { ...loaded.schema, tags: [tag], components: [component], project: { ...loaded.schema.project, svgAssetId: uploaded.assetId } }
  const saved = await request(`/api/draft?projectId=${projectId}`, { method: 'PUT', body: JSON.stringify({ projectId, schema, revision: loaded.revision }) })
  const published = await request('/api/publish', { method: 'POST', body: JSON.stringify({ projectId, expectedDraftRevision: saved.revision, idempotencyKey: randomUUID(), message: 'Phase 3 isolated smoke' }) })
  const runtime = await request(`/api/runtime?slug=${slug}`)
  const scoped = await request('/api/runtime-session', { method: 'POST', body: JSON.stringify({ projectId }) })
  const commandRequestId = randomUUID()
  const command = await request('/api/commands', { method: 'POST', body: JSON.stringify({ projectId, runtimeToken: scoped.token, requestId: commandRequestId, componentId: component.id, confirmed: true }) })
  const replay = await request('/api/commands', { method: 'POST', body: JSON.stringify({ projectId, runtimeToken: scoped.token, requestId: commandRequestId, componentId: component.id, confirmed: true }) })
  const versions = await request(`/api/versions?projectId=${projectId}`)
  const audit = await request(`/api/audit?projectId=${projectId}&limit=20`)
  const result = {
    projectId,
    slug,
    publishedVersion: published.version,
    runtimeVersion: runtime.version,
    runtimeBundleProject: runtime.projectId === projectId,
    commandStatus: command.status,
    commandReplayDeduplicated: replay.replayed,
    versionCount: versions.versions.length,
    auditActions: audit.events.map(event => event.action),
  }
  if (result.publishedVersion !== 1 || result.runtimeVersion !== 1 || !result.runtimeBundleProject || command.status !== 'acknowledged' || !replay.replayed || !result.auditActions.includes('project.publish') || !result.auditActions.includes('command.acknowledged')) throw new Error(`Smoke assertions failed: ${JSON.stringify(result)}`)
  console.log(JSON.stringify(result, null, 2))
} finally {
  if (projectId && !keepProject) {
    await request(`/api/projects?id=${projectId}`, { method: 'DELETE', body: JSON.stringify({ projectId, confirmSlug: projectSlug }) }).catch(error => console.error(`Smoke cleanup failed: ${error.message}`))
  }
}
