import { COMPONENT_REGISTRY } from './component-registry.js'

const DEFAULT_HINT = 'Review the reported field in the project editor, correct its value, and run validation again.'
const ISSUE_HINTS = Object.freeze({
  'schema.invalid': 'Reload the project or import a JSON object that contains the expected project schema fields.',
  'schema.version': 'Open and save the project with the current builder so its schema can be migrated.',
  'schema.secret': 'Remove the credential from the project schema and configure it in the encrypted connector environment instead.',
  'project.identity': 'Use a stable project id, a readable name, and a lowercase kebab-case slug.',
  'project.runtimeProfile': 'Choose SIMULATION, REAL PLC, or MONITOR ONLY in Tags & simulation.',
  'canvas.invalid': 'Set a finite canvas width and height of at least 320 × 240.',
  'asset.missing': 'Upload and sanitize the base SVG in Schematic Assets before publishing.',
  'asset.notFound': 'Upload the base SVG again; the schema points to an asset that is no longer stored.',
  'source.id': 'Give every data source a non-empty, unique id.',
  'source.connector': 'Select or create a connector for this live data source.',
  'connector.missing': 'Open Data sources and select an enabled connector owned by this project.',
  'connector.unhealthy': 'Check the connector environment and restore its online heartbeat before publishing.',
  'profile.liveSource': 'Add a live connector-backed source or switch the runtime profile to SIMULATION.',
  'tag.id': 'Give every tag a unique id; then update component bindings that referenced the old id.',
  'tag.name': 'Enter a short display name for the tag.',
  'tag.path': 'Use a unique telemetry key/path for each signal.',
  'tag.source': 'Select an existing data source for this tag.',
  'tag.engineering.range': 'Set Engineering max greater than Engineering min.',
  'tag.numberFormat': 'Choose Normal number or Percentage; Percentage uses the % engineering unit automatically.',
  'tag.writeConstraints.range': 'Keep command min/max ordered and inside the engineering range.',
  'tag.writeConstraints.step': 'Use a positive command step no larger than the command range.',
  'tag.alarmRule': 'Choose a numeric comparison and keep its trigger value or range inside the Tag engineering limits.',
  'component.id': 'Give every component a unique id so bindings and pop-up references remain deterministic.',
  'component.position': 'Enter finite X, Y, width, height, and rotation values.',
  'component.size': 'Set component width and height to values greater than zero.',
  'component.bounds': 'Move or resize the component until it fits inside the logical canvas.',
  'binding.missing': 'Select a compatible tag in the component Properties panel.',
  'binding.broken': 'Rebind the component to an existing tag or restore the referenced tag.',
  'binding.type': 'Choose a tag whose data type is supported by this component.',
  'binding.readonly': 'Bind command components to a write or read-write tag.',
  'command.feedback': 'Select an existing readable feedback tag, or use two-way RPC acknowledgment.',
  'command.feedback.readable': 'Choose a read or read-write tag for feedback acknowledgment.',
  'command.feedback.type': 'Choose feedback with the same value semantics required by this command.',
  'command.rpcMethod': 'Use only letters, numbers, dot, underscore, colon, and hyphen in RPC methods.',
  'command.rpcMethod.duplicate': 'Assign a unique RPC method to every command component to avoid ambiguous dispatch.',
  'rule.value': 'Enter a finite number for this comparison operator.',
  'rule.range': 'Set a finite minimum and maximum with maximum greater than or equal to minimum.',
  'alarm': 'Choose Lamp or Buzzer and keep its color, frequency, volume, and pulse settings inside the allowed ranges.',
  'tuning.overrideRange': 'Keep a custom Slider range inside the Tag command limits.',
  'tuning.overrideStep': 'Use a Slider step that is a whole multiple of the Tag command step.',
  'gauge.zones': 'Keep low and high zone boundaries ordered inside the Gauge range.',
  'value.thresholds.high': 'Set Critical high greater than or equal to Warning high.',
  'value.thresholds.low': 'Set Critical low less than or equal to Warning low.',
  'operation.control': 'Reference only existing Control Button or Tuning Slider components.',
  'operation.stepControl': 'Select an existing Control Button for this AUTO sequence step.',
  'popup.child.missing': 'Remove the stale child reference or add the missing control again.',
  'popup.child.owner': 'Keep a control in only one Control Pop-up.',
  'designImage.asset': 'Upload the design image again and reselect the stored asset.',
  'designAsset.missing': 'Upload the missing design element again, then replace this component asset.',
})

export function validationSummary(issues = []) {
  return (Array.isArray(issues) ? issues : []).reduce((summary, issue) => {
    if (issue?.severity === 'error') summary.errors += 1
    else if (issue?.severity === 'warning') summary.warnings += 1
    else summary.info += 1
    summary.total += 1
    return summary
  }, { total: 0, errors: 0, warnings: 0, info: 0 })
}

export function validationDiagnostics(schema, issues = []) {
  return (Array.isArray(issues) ? issues : []).map((issue, index) => {
    const normalized = normalizeIssue(issue)
    const context = issueContext(schema, normalized.path)
    const rawValue = normalized.redacted ? undefined : valueAtIssuePath(schema, normalized.path, context)
    return {
      ...normalized,
      id: `${normalized.severity}:${normalized.code}:${normalized.path}:${index}`,
      sourceKind: context.kind,
      sourceLabel: context.label,
      sourceId: context.id,
      sourceIndex: context.index,
      field: context.field,
      currentValue: normalized.redacted ? '[redacted]' : summarizeValue(rawValue),
      hint: normalized.hint || issueHint(normalized.code),
      relatedPaths: Array.isArray(normalized.relatedPaths) ? normalized.relatedPaths.filter(Boolean).map(String) : [],
    }
  }).sort(compareDiagnostics)
}

export function validationConsoleReport({ projectName = 'Untitled project', origin = 'Draft validation', diagnostics = [] } = {}) {
  const summary = validationSummary(diagnostics)
  const lines = [
    `PROJECT VALIDATION CONSOLE · ${projectName}`,
    `Origin: ${origin}`,
    `Result: ${summary.errors} error(s), ${summary.warnings} warning(s)`,
    '',
  ]
  if (!diagnostics.length) lines.push('PASS · No validation issues found.')
  diagnostics.forEach((diagnostic, index) => {
    lines.push(`[${String(diagnostic.severity).toUpperCase()} ${index + 1}] ${diagnostic.code}`)
    lines.push(`Source: ${diagnostic.sourceLabel}`)
    if (diagnostic.path) lines.push(`Path: ${diagnostic.path}`)
    if (diagnostic.currentValue) lines.push(`Current: ${diagnostic.currentValue}`)
    lines.push(`Message: ${diagnostic.message}`)
    lines.push(`Fix: ${diagnostic.hint}`)
    if (diagnostic.relatedPaths?.length) lines.push(`Related: ${diagnostic.relatedPaths.join(', ')}`)
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

function normalizeIssue(issue) {
  const value = issue && typeof issue === 'object' ? issue : {}
  return {
    ...value,
    severity: value.severity === 'warning' ? 'warning' : value.severity === 'info' ? 'info' : 'error',
    code: String(value.code || 'validation.unknown'),
    message: String(value.message || 'Unknown validation issue.'),
    path: String(value.path || ''),
    redacted: value.redacted === true,
  }
}

function issueContext(schema, path) {
  const segments = path ? path.split('.').filter(Boolean) : []
  const root = segments[0]
  if (root === 'components') return collectionContext(schema?.components, segments, 'Component', componentLabel)
  if (root === 'tags') return collectionContext(schema?.tags, segments, 'Tag', item => item?.name || item?.id)
  if (root === 'dataSources') return collectionContext(schema?.dataSources, segments, 'Data source', item => item?.id || item?.type)
  if (root === 'project') {
    return { kind: 'project', label: `Project · ${schema?.project?.name || schema?.project?.id || 'configuration'}`, id: schema?.project?.id || null, index: null, field: segments.slice(1).join('.') || 'project' }
  }
  if (root === 'schemaVersion') return { kind: 'schema', label: 'Project schema', id: null, index: null, field: 'schemaVersion' }
  return { kind: 'schema', label: 'Project schema', id: null, index: null, field: path || 'root' }
}

function collectionContext(collection, segments, kind, labelForItem) {
  const items = Array.isArray(collection) ? collection : []
  const reference = segments[1]
  const numericIndex = /^\d+$/.test(reference || '') ? Number(reference) : -1
  const index = numericIndex >= 0 ? numericIndex : items.findIndex(item => item?.id === reference)
  const item = index >= 0 ? items[index] : null
  const itemLabel = labelForItem(item) || reference || 'collection'
  const displayIndex = index >= 0 ? ` #${index + 1}` : ''
  return {
    kind: kind.toLowerCase().replace(' ', '-'),
    label: `${kind}${displayIndex} · ${itemLabel}`,
    id: item?.id || (numericIndex < 0 ? reference : null) || null,
    index: index >= 0 ? index : null,
    field: segments.slice(2).join('.') || kind.toLowerCase(),
  }
}

function componentLabel(component) {
  const type = COMPONENT_REGISTRY[component?.type]?.label || component?.type || 'Unknown type'
  return component?.name ? `${component.name} (${type})` : type
}

function valueAtIssuePath(schema, path, context) {
  if (!path) return schema
  const segments = path.split('.').filter(Boolean)
  if (['components', 'tags', 'dataSources'].includes(segments[0]) && context.index != null) {
    segments[1] = String(context.index)
  }
  let current = schema
  for (const segment of segments) {
    if (current == null || (typeof current !== 'object' && !Array.isArray(current))) return undefined
    current = current[segment]
  }
  return current
}

function summarizeValue(value) {
  if (value === undefined) return '<missing>'
  if (value === null) return 'null'
  if (typeof value === 'string') return value.length > 120 ? `${JSON.stringify(value.slice(0, 117))}…` : JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    return `{${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''}}`
  }
  return String(value).slice(0, 120)
}

function issueHint(code) {
  if (ISSUE_HINTS[code]) return ISSUE_HINTS[code]
  const prefix = Object.keys(ISSUE_HINTS).find(candidate => code.startsWith(`${candidate}.`))
  return prefix ? ISSUE_HINTS[prefix] : DEFAULT_HINT
}

function compareDiagnostics(left, right) {
  const severityOrder = { error: 0, warning: 1, info: 2 }
  return (severityOrder[left.severity] ?? 3) - (severityOrder[right.severity] ?? 3)
    || left.sourceLabel.localeCompare(right.sourceLabel)
    || left.path.localeCompare(right.path)
    || left.code.localeCompare(right.code)
}
