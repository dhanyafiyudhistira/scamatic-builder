import { hasBlockingIssues, migrateProjectSchema, validateProjectSchema } from '../../shared/project-schema.js'

export function selectConnectorRuntimeSchema({ connector, environmentRef, publishedVersion = null, draft = null }) {
  const published = selectionFromSchema({
    connector,
    environmentRef,
    schema: publishedVersion?.schema,
    mode: 'published',
    identity: publishedVersion?._id || publishedVersion?.id,
  })
  if (published) return published

  const draftSchema = migrateProjectSchema(draft?.schema)
  if (!draftSchema || draftSchema.project?.id !== String(connector.projectId)) return null
  if (hasBlockingIssues(validateProjectSchema(draftSchema))) return null

  return selectionFromSchema({
    connector,
    environmentRef,
    schema: draftSchema,
    mode: 'bootstrap',
    identity: `${draft?.revision || 0}:${dateIdentity(draft?.updatedAt)}`,
  })
}

function selectionFromSchema({ connector, environmentRef, schema, mode, identity }) {
  if (!schema || !identity) return null
  const connectorId = String(connector._id || connector.id)
  const source = (schema.dataSources || []).find(item =>
    item.type === connector.type &&
    String(item.connectorRef || '') === connectorId &&
    (item.environmentRef || 'staging') === environmentRef
  )
  if (!source) return null

  const bindings = (schema.tags || []).filter(tag =>
    tag.sourceId === source.id && (mode === 'published' || tag.access !== 'write')
  )
  if (!bindings.length) return null

  return {
    mode,
    source,
    bindings,
    fingerprint: `${mode}:${identity}`,
  }
}

function dateIdentity(value) {
  if (!value) return 'unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}
