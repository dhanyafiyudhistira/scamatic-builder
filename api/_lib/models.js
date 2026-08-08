import mongoose from 'mongoose'
import { randomUUID } from 'node:crypto'

// Every request path must establish a connection explicitly. Silent model
// buffering hides connectivity failures and otherwise turns them into an
// unrelated-looking query timeout several seconds later.
mongoose.set('bufferCommands', false)

function defineModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema)
}

export const ROLES = Object.freeze(['OWNER', 'ADMIN', 'EDITOR', 'OPERATOR', 'VIEWER'])

const settingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  serverUrl: { type: String, default: '' },
  deviceId: { type: String, default: '' },
  token: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now },
}, { _id: false })
export const Settings = defineModel('Settings', settingsSchema)

const telemetrySchema = new mongoose.Schema({
  workspaceId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  tag: { type: String, required: true, index: true },
  value: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now, index: true },
})
telemetrySchema.index({ workspaceId: 1, projectId: 1, tag: 1, timestamp: -1 })
export const Telemetry = defineModel('Telemetry', telemetrySchema)

const userSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  email: { type: String, required: true, trim: true, lowercase: true },
  displayName: { type: String, default: '' },
  passwordHash: { type: String, required: true, select: false },
  status: { type: String, enum: ['active', 'disabled'], default: 'active', index: true },
  authVersion: { type: Number, default: 1 },
}, { timestamps: true })
userSchema.index({ email: 1 }, { unique: true })
export const User = defineModel('ScadaUser', userSchema)

const workspaceSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  slug: { type: String, required: true, trim: true, lowercase: true },
  name: { type: String, required: true, trim: true },
  ownerId: { type: String, required: true, index: true },
}, { timestamps: true })
workspaceSchema.index({ slug: 1 }, { unique: true })
export const Workspace = defineModel('ScadaWorkspace', workspaceSchema)

const workspaceMemberSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  workspaceId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  role: { type: String, enum: ROLES, required: true },
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
}, { timestamps: true })
workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true })
export const WorkspaceMember = defineModel('ScadaWorkspaceMember', workspaceMemberSchema)

const projectMemberSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  projectId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  role: { type: String, enum: ['EDITOR', 'OPERATOR', 'VIEWER'], required: true },
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
}, { timestamps: true })
projectMemberSchema.index({ projectId: 1, userId: 1 }, { unique: true })
export const ProjectMember = defineModel('ScadaProjectMember', projectMemberSchema)

const authSessionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  workspaceId: { type: String, required: true, index: true },
  csrfHash: { type: String, required: true },
  authVersion: { type: Number, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  revokedAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: Date.now },
  userAgent: { type: String, default: '' },
}, { timestamps: true })
authSessionSchema.index({ userId: 1, revokedAt: 1, createdAt: -1 })
export const AuthSession = defineModel('ScadaAuthSession', authSessionSchema)

const runtimeSessionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  authSessionId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  workspaceId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  versionId: { type: String, required: true },
  responderId: { type: String, default: null, index: true },
  responderGeneration: { type: Number, default: 1 },
  capabilities: { type: [String], default: [] },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  revokedAt: { type: Date, default: null },
}, { timestamps: true })
runtimeSessionSchema.index({ authSessionId: 1, projectId: 1, revokedAt: 1, createdAt: -1 })
export const RuntimeSession = defineModel('ScadaRuntimeSession', runtimeSessionSchema)

const simulationResponderLeaseSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  responderKey: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  versionId: { type: String, required: true },
  runtimeSessionId: { type: String, required: true, index: true },
  responderId: { type: String, required: true, index: true },
  responderGeneration: { type: Number, required: true, default: 1 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true })
export const SimulationResponderLease = defineModel('ScadaSimulationResponderLease', simulationResponderLeaseSchema)

const simulationRpcLifecycleSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  projectId: { type: String, required: true, index: true },
  versionId: { type: String, required: true },
  requestId: { type: String, required: true },
  request: { type: mongoose.Schema.Types.Mixed, required: true },
  responsePayload: { type: mongoose.Schema.Types.Mixed, default: undefined },
  telemetryPayload: { type: mongoose.Schema.Types.Mixed, default: undefined },
  telemetryTimestamp: { type: Number, default: null },
  publishTelemetry: { type: Boolean, default: false },
  status: { type: String, enum: ['received', 'telemetry_published', 'responded'], default: 'received', required: true },
  responderRuntimeSessionId: { type: String, required: true, index: true },
  receivedAt: { type: Date, required: true, default: Date.now },
  telemetryPublishedAt: { type: Date, default: null },
  respondedAt: { type: Date, default: null },
  processingStage: { type: String, enum: ['telemetry', 'response', null], default: null },
  processingOwner: { type: String, default: null },
  processingExpiresAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true })
simulationRpcLifecycleSchema.index({ projectId: 1, versionId: 1, status: 1, receivedAt: 1 })
export const SimulationRpcLifecycle = defineModel('ScadaSimulationRpcLifecycle', simulationRpcLifecycleSchema)

const runtimeStreamSessionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  runtimeSessionId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  workspaceId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  versionId: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  consumedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
}, { timestamps: true })
runtimeStreamSessionSchema.index({ runtimeSessionId: 1, revokedAt: 1, expiresAt: 1 })
export const RuntimeStreamSession = defineModel('ScadaRuntimeStreamSession', runtimeStreamSessionSchema)

const projectUnlockSessionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  authSessionId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  pinVersion: { type: Number, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true })
projectUnlockSessionSchema.index({ authSessionId: 1, projectId: 1 }, { unique: true })
export const ProjectUnlockSession = defineModel('ScadaProjectUnlockSession', projectUnlockSessionSchema)

const connectorSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  workspaceId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['thingsboard'], required: true },
  enabled: { type: Boolean, default: false },
  createdBy: { type: String, required: true },
  updatedBy: { type: String, required: true },
}, { timestamps: true })
connectorSchema.index({ projectId: 1, name: 1 }, { unique: true })
export const Connector = defineModel('ScadaConnector', connectorSchema)

const connectorEnvironmentSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  connectorId: { type: String, required: true, index: true },
  workspaceId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  environmentRef: { type: String, enum: ['development', 'staging', 'production'], default: 'staging' },
  config: { type: mongoose.Schema.Types.Mixed, default: {} },
  health: {
    state: { type: String, enum: ['unconfigured', 'connecting', 'online', 'degraded', 'offline', 'error'], default: 'unconfigured' },
    message: { type: String, default: '' },
    checkedAt: { type: Date, default: null },
    connectedAt: { type: Date, default: null },
    lastEventAt: { type: Date, default: null },
  },
  commandHealth: {
    state: { type: String, enum: ['unknown', 'waiting', 'online', 'unverified', 'degraded'], default: 'unknown' },
    message: { type: String, default: 'No RPC result observed yet.' },
    checkedAt: { type: Date, default: null },
    lastAcknowledgedAt: { type: Date, default: null },
    lastTimeoutAt: { type: Date, default: null },
  },
  authentication: {
    mode: { type: String, enum: ['unconfigured', 'manual-jwt', 'refresh-token'], default: 'unconfigured' },
    state: { type: String, enum: ['unconfigured', 'manual', 'healthy', 'expiring', 'refreshing', 'error'], default: 'unconfigured' },
    message: { type: String, default: 'ThingsBoard authentication is not configured.' },
    accessTokenExpiresAt: { type: Date, default: null },
    refreshTokenExpiresAt: { type: Date, default: null },
    lastRefreshedAt: { type: Date, default: null },
    lastRefreshAttemptAt: { type: Date, default: null },
    refreshLeaseOwner: { type: String, default: null },
    refreshLeaseUntil: { type: Date, default: null },
  },
  secretConfiguredAt: { type: Date, default: null },
  deviceTokenConfiguredAt: { type: Date, default: null },
  updatedBy: { type: String, required: true },
}, { timestamps: true })
connectorEnvironmentSchema.index({ connectorId: 1, environmentRef: 1 }, { unique: true })
export const ConnectorEnvironment = defineModel('ScadaConnectorEnvironment', connectorEnvironmentSchema)

const connectorSecretSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  connectorId: { type: String, required: true, index: true },
  environmentRef: { type: String, required: true },
  payloadCiphertext: { type: String, required: true, select: false },
  payloadIv: { type: String, required: true, select: false },
  payloadTag: { type: String, required: true, select: false },
  wrappedKey: { type: String, required: true, select: false },
  wrappedKeyIv: { type: String, required: true, select: false },
  wrappedKeyTag: { type: String, required: true, select: false },
  keyVersion: { type: String, default: 'v1', select: false },
  rotatedBy: { type: String, required: true },
}, { timestamps: true })
export const ConnectorSecret = defineModel('ScadaConnectorSecret', connectorSecretSchema)

const connectorHealthEventSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  connectorId: { type: String, required: true, index: true },
  workspaceId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  environmentRef: { type: String, required: true },
  state: { type: String, required: true },
  message: { type: String, default: '' },
  metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: 'timestamp', updatedAt: false } })
connectorHealthEventSchema.index({ connectorId: 1, timestamp: -1 })
export const ConnectorHealthEvent = defineModel('ScadaConnectorHealthEvent', connectorHealthEventSchema)

const tagValueSnapshotSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  workspaceId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  sourceId: { type: String, required: true },
  tagId: { type: String, required: true },
  value: { type: mongoose.Schema.Types.Mixed, default: null },
  dataType: { type: String, required: true },
  sourceTimestamp: { type: Date, required: true },
  receivedAt: { type: Date, required: true },
  quality: { type: String, enum: ['good', 'stale', 'bad', 'disconnected'], required: true },
  sequence: { type: Number, required: true },
}, { timestamps: true })
tagValueSnapshotSchema.index({ projectId: 1, tagId: 1 }, { unique: true })
export const TagValueSnapshot = defineModel('ScadaTagValueSnapshot', tagValueSnapshotSchema)

const chartStorageConfigurationSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  workspaceId: { type: String, required: true, unique: true, index: true },
  enabled: { type: Boolean, default: false },
  dbName: { type: String, default: 'scamatic_telemetry' },
  collectionName: { type: String, default: 'chart_samples' },
  retentionDays: { type: Number, default: 30 },
  batchSize: { type: Number, default: 500 },
  flushMs: { type: Number, default: 250 },
  maxQueue: { type: Number, default: 20_000 },
  maxPoolSize: { type: Number, default: 20 },
  maxBootstrapPoints: { type: Number, default: 10_000 },
  targetLabel: { type: String, default: '' },
  secretConfiguredAt: { type: Date, default: null },
  health: {
    state: { type: String, enum: ['unconfigured', 'testing', 'ready', 'degraded', 'error'], default: 'unconfigured' },
    message: { type: String, default: '' },
    checkedAt: { type: Date, default: null },
  },
  updatedBy: { type: String, required: true },
}, { timestamps: true })
export const ChartStorageConfiguration = defineModel('ScadaChartStorageConfiguration', chartStorageConfigurationSchema)

const chartStorageSecretSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  workspaceId: { type: String, required: true, unique: true, index: true },
  payloadCiphertext: { type: String, required: true, select: false },
  payloadIv: { type: String, required: true, select: false },
  payloadTag: { type: String, required: true, select: false },
  wrappedKey: { type: String, required: true, select: false },
  wrappedKeyIv: { type: String, required: true, select: false },
  wrappedKeyTag: { type: String, required: true, select: false },
  keyVersion: { type: String, default: 'v1', select: false },
  rotatedBy: { type: String, required: true },
}, { timestamps: true })
export const ChartStorageSecret = defineModel('ScadaChartStorageSecret', chartStorageSecretSchema)

const projectSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  workspaceId: { type: String, default: 'default', index: true },
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  canvas: { width: Number, height: Number, background: String },
  svgAssetId: { type: String, default: null },
  activeVersionId: { type: String, default: null },
  hiddenAt: { type: Date, default: null, index: true },
  security: {
    pinEnabled: { type: Boolean, default: false },
    pinHash: { type: String, default: null, select: false },
    pinVersion: { type: Number, default: 0 },
    pinConfiguredAt: { type: Date, default: null },
    pinConfiguredBy: { type: String, default: null },
  },
  lastVersionNumber: { type: Number, default: 0 },
  createdBy: { type: String, required: true },
  updatedBy: { type: String, required: true },
}, { timestamps: true })
projectSchema.index({ workspaceId: 1, slug: 1 }, { unique: true })
export const Project = defineModel('ScadaProject', projectSchema)

const draftSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  schema: { type: mongoose.Schema.Types.Mixed, required: true },
  revision: { type: Number, default: 1 },
  updatedBy: { type: String, required: true },
}, { timestamps: true })
export const ProjectDraft = defineModel('ScadaProjectDraft', draftSchema)

const assetSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  projectId: { type: String, required: true, index: true },
  kind: { type: String, enum: ['svg', 'design-image'], default: 'svg' },
  content: { type: String, required: true },
  checksum: { type: String, required: true },
  byteLength: { type: Number, required: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: String, required: true },
}, { timestamps: true })
export const ScadaAsset = defineModel('ScadaAsset', assetSchema)

const versionSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  projectId: { type: String, required: true, index: true },
  version: { type: Number, required: true },
  schema: { type: mongoose.Schema.Types.Mixed, required: true },
  checksum: { type: String, required: true },
  validationSummary: { type: mongoose.Schema.Types.Mixed, required: true },
  idempotencyKey: { type: String, required: true },
  message: { type: String, default: '' },
  draftRevision: { type: Number, required: true },
  assetId: { type: String, required: true },
  assetChecksum: { type: String, required: true },
  restoredFromVersionId: { type: String, default: null },
  restoredFromVersion: { type: Number, default: null },
  environmentRef: { type: String, default: 'mock' },
  createdBy: { type: String, required: true },
}, { timestamps: true })
versionSchema.index({ projectId: 1, version: 1 }, { unique: true })
versionSchema.index({ projectId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } })
export const ProjectVersion = defineModel('ScadaProjectVersion', versionSchema)

const auditSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  workspaceId: { type: String, default: 'default', index: true },
  projectId: { type: String, default: null, index: true },
  actorId: { type: String, required: true },
  action: { type: String, required: true },
  targetType: { type: String, required: true },
  targetId: { type: String, default: null },
  correlationId: { type: String, default: null, index: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: 'timestamp', updatedAt: false } })
auditSchema.index({ projectId: 1, timestamp: -1 })
export const AuditEvent = defineModel('ScadaAuditEvent', auditSchema)

const commandEventSchema = new mongoose.Schema({
  _id: { type: String, default: () => randomUUID() },
  requestId: { type: String, required: true },
  workspaceId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  versionId: { type: String, required: true },
  componentId: { type: String, required: true },
  tagId: { type: String, required: true },
  actorId: { type: String, required: true, index: true },
  executionMode: { type: String, enum: ['mock', 'serverless', 'worker'], default: 'worker', index: true },
  status: { type: String, enum: ['requested', 'authorized', 'dispatched', 'accepted_by_gateway', 'acknowledged', 'rejected', 'timeout', 'failed'], required: true },
  action: { type: String, required: true },
  payloadSummary: { type: mongoose.Schema.Types.Mixed, default: {} },
  resultSummary: { type: mongoose.Schema.Types.Mixed, default: {} },
  correlationId: { type: String, required: true },
  completedAt: { type: Date, default: null },
}, { timestamps: true })
commandEventSchema.index({ projectId: 1, requestId: 1 }, { unique: true })
commandEventSchema.index({ projectId: 1, createdAt: -1 })
export const CommandEvent = defineModel('ScadaCommandEvent', commandEventSchema)

const requestLimitSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
})
export const RequestLimit = defineModel('ScadaRequestLimit', requestLimitSchema)
