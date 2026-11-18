export const SCADA_PROJECT_TYPE = 'scada'
export const IOT_DASHBOARD_PROJECT_TYPE = 'iot-dashboard'
export const DEFAULT_PROJECT_TYPE = SCADA_PROJECT_TYPE
export const PROJECT_TYPES = Object.freeze([SCADA_PROJECT_TYPE, IOT_DASHBOARD_PROJECT_TYPE])
export const WINCC_OUTPUT_TARGET = 'wincc-unified'
export const DEFAULT_OUTPUT_TARGET = 'scamatic'
export const SCADA_OUTPUT_TARGETS = Object.freeze([DEFAULT_OUTPUT_TARGET, WINCC_OUTPUT_TARGET])
export const WINCC_TEMPLATE_COMPONENT_TYPES = Object.freeze(['text-label', 'indicator-lamp', 'value-span', 'gauge', 'control-button'])

export function projectOutputTarget(project) {
  return projectTypeOf(project) === SCADA_PROJECT_TYPE && project?.outputTarget === WINCC_OUTPUT_TARGET
    ? WINCC_OUTPUT_TARGET
    : DEFAULT_OUTPUT_TARGET
}

export function winccTemplateSchema(schema) {
  if (!schema?.project || !Array.isArray(schema.components)) return schema
  return {
    ...schema,
    project: { ...schema.project, runtimeProfile: 'simulation' },
    dataSources: [],
    tags: [],
    components: schema.components.map(component => component && ({
      ...component,
      binding: component.type === 'chart' ? { tagIds: [] } : { tagId: null },
    })),
  }
}

const PROJECT_TYPE_METADATA = Object.freeze({
  [SCADA_PROJECT_TYPE]: Object.freeze({
    id: SCADA_PROJECT_TYPE,
    label: 'SCADA',
    builderLabel: 'SCADA Builder',
    description: 'Industrial schematic screens with optional Node-RED flow exchange.',
    canvas: Object.freeze({ width: 1920, height: 1080, background: '#101418' }),
  }),
  [IOT_DASHBOARD_PROJECT_TYPE]: Object.freeze({
    id: IOT_DASHBOARD_PROJECT_TYPE,
    label: 'IoT Dashboard',
    builderLabel: 'IoT Dashboard Builder',
    description: 'Responsive telemetry dashboards connected directly through the ThingsBoard runtime.',
    canvas: Object.freeze({ width: 1440, height: 900, background: '#081018' }),
  }),
})

export function validProjectType(value) {
  return PROJECT_TYPES.includes(String(value || '').trim().toLowerCase())
}

export function normalizeProjectType(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return validProjectType(normalized) ? normalized : DEFAULT_PROJECT_TYPE
}

export function projectTypeOf(value) {
  if (typeof value === 'string') return normalizeProjectType(value)
  return normalizeProjectType(value?.project?.projectType ?? value?.projectType)
}

export function projectTypeMetadata(value) {
  return PROJECT_TYPE_METADATA[projectTypeOf(value)]
}

export function isIotDashboardProject(value) {
  return projectTypeOf(value) === IOT_DASHBOARD_PROJECT_TYPE
}

export function projectRequiresSchematicAsset(value) {
  return !isIotDashboardProject(value)
}
