import test from 'node:test'
import assert from 'node:assert/strict'
import { createNodeRedExport } from '../shared/node-red-export.js'
import { createProjectSchema, hasBlockingIssues, migrateProjectSchema, PROJECT_SCHEMA_VERSION, validateProjectSchema } from '../shared/project-schema.js'
import { IOT_DASHBOARD_PROJECT_TYPE, SCADA_PROJECT_TYPE, isIotDashboardProject, projectRequiresSchematicAsset, projectTypeMetadata, projectTypeOf, validProjectType } from '../shared/project-type.js'
import { Project, ProjectVersion } from '../api/_lib/models.js'
import { sanitizeThingsBoardConfig } from '../api/_handlers/connectors.js'

test('project type metadata keeps SCADA as the backward-compatible default', () => {
  assert.equal(projectTypeOf(null), SCADA_PROJECT_TYPE)
  assert.equal(projectTypeOf({}), SCADA_PROJECT_TYPE)
  assert.equal(validProjectType(SCADA_PROJECT_TYPE), true)
  assert.equal(validProjectType(IOT_DASHBOARD_PROJECT_TYPE), true)
  assert.equal(validProjectType('dashboard'), false)
  assert.equal(projectTypeMetadata(IOT_DASHBOARD_PROJECT_TYPE).canvas.width, 1440)
})

test('new IoT Dashboard schemas use the shared schema with dashboard defaults', () => {
  const schema = createProjectSchema({ id: 'iot-1', name: 'Fleet', slug: 'fleet', projectType: IOT_DASHBOARD_PROJECT_TYPE })
  assert.equal(schema.project.projectType, IOT_DASHBOARD_PROJECT_TYPE)
  assert.equal(schema.project.canvas.width, 1440)
  assert.equal(schema.project.canvas.height, 900)
  assert.equal(schema.project.canvas.background, '#081018')
  assert.equal(isIotDashboardProject(schema), true)
  assert.equal(projectRequiresSchematicAsset(schema), false)
  assert.equal(hasBlockingIssues(validateProjectSchema(schema, { requireAsset: projectRequiresSchematicAsset(schema) })), false)
})

test('stored IoT dashboards migrate the retired blue canvas default without replacing custom colors', () => {
  const legacyBlue = createProjectSchema({ id: 'iot-blue', name: 'Blue', slug: 'blue', projectType: IOT_DASHBOARD_PROJECT_TYPE })
  legacyBlue.project.canvas.background = '#0B1020'
  const migratedBlue = migrateProjectSchema(legacyBlue)
  assert.equal(migratedBlue.project.canvas.background, '#081018')
  assert.equal(legacyBlue.project.canvas.background, '#0B1020')

  const custom = createProjectSchema({ id: 'iot-custom', name: 'Custom', slug: 'custom', projectType: IOT_DASHBOARD_PROJECT_TYPE })
  custom.project.canvas.background = '#123456'
  assert.equal(migrateProjectSchema(custom).project.canvas.background, '#123456')
})

test('SCADA schemas retain their sanitized base schematic publish requirement', () => {
  const schema = createProjectSchema({ id: 'scada-1', name: 'Plant', slug: 'plant' })
  assert.equal(schema.project.projectType, SCADA_PROJECT_TYPE)
  assert.equal(projectRequiresSchematicAsset(schema), true)
  assert.ok(validateProjectSchema(schema, { requireAsset: true }).some(issue => issue.code === 'asset.missing'))
})

test('1.6 projects migrate to SCADA without mutating the stored input', () => {
  const legacy = createProjectSchema({ id: 'legacy-1', name: 'Legacy', slug: 'legacy' })
  legacy.schemaVersion = '1.6.0'
  delete legacy.project.projectType
  legacy.tags.push({ id: 'pressure', name: 'Pressure', path: 'pressure', dataType: 'number', access: 'read', sourceId: 'source_mock', engineering: { min: 10, max: 20, unit: 'bar', decimals: 2 } })
  const migrated = migrateProjectSchema(legacy)
  assert.equal(migrated.schemaVersion, PROJECT_SCHEMA_VERSION)
  assert.equal(migrated.project.projectType, SCADA_PROJECT_TYPE)
  assert.deepEqual(migrated.tags[0].engineering, { min: 10, max: 20, unit: 'bar', decimals: 2 })
  assert.equal(legacy.project.projectType, undefined)
})

test('invalid project types fail validation and IoT projects cannot export Node-RED flows', () => {
  const invalid = createProjectSchema({ id: 'bad-1', name: 'Bad', slug: 'bad' })
  invalid.project.projectType = 'dashboard'
  assert.ok(validateProjectSchema(invalid).some(issue => issue.code === 'project.type'))

  const iot = createProjectSchema({ id: 'iot-2', name: 'Direct', slug: 'direct', projectType: IOT_DASHBOARD_PROJECT_TYPE })
  assert.throws(() => createNodeRedExport(iot), /unavailable for IoT Dashboard/)
})

test('persistence defaults legacy projects to SCADA and permits an asset-free IoT version', () => {
  const project = new Project({ workspaceId: 'workspace-1', name: 'Legacy', slug: 'legacy', createdBy: 'owner-1', updatedBy: 'owner-1' })
  assert.equal(project.projectType, SCADA_PROJECT_TYPE)

  const version = new ProjectVersion({
    projectId: 'iot-1',
    version: 1,
    schema: createProjectSchema({ id: 'iot-1', name: 'IoT', slug: 'iot', projectType: IOT_DASHBOARD_PROJECT_TYPE }),
    checksum: 'a'.repeat(64),
    validationSummary: { issues: [] },
    idempotencyKey: 'iot-version-1',
    draftRevision: 1,
    environmentRef: 'mock',
    createdBy: 'owner-1',
  })
  const validationError = version.validateSync()
  assert.equal(validationError?.errors?.assetId, undefined)
  assert.equal(validationError?.errors?.assetChecksum, undefined)
})

test('IoT connector drafts may defer device selection while enabled connectors may not', () => {
  assert.deepEqual(sanitizeThingsBoardConfig({ serverUrl: 'https://tb.example.com' }, { deviceRequired: false }).deviceId, '')
  assert.throws(() => sanitizeThingsBoardConfig({ serverUrl: 'https://tb.example.com' }), /deviceId is required/)
})
