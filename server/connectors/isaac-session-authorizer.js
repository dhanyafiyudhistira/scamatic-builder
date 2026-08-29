import { createHash, timingSafeEqual } from 'node:crypto'
import { isAuthSessionRecordActive } from '../../api/_lib/auth.js'
import { AuthSession, Project, ProjectVersion, RuntimeSession, RuntimeStreamSession } from '../../api/_lib/models.js'
import { ISAAC_RUNTIME_ENGINE } from '../../shared/runtime-engine.js'

const MAX_RUNTIME_TAGS = 20_000
const MAX_RUNTIME_TAG_ID_BYTES = 1_000_000

export function createIsaacSessionAuthorizer({
  internalToken,
  authorize = authorizeIsaacStreamTicket,
  revalidate = revalidateIsaacRuntimeSession,
} = {}) {
  const expectedToken = String(internalToken || '')
  return async function isaacSessionAuthorizer(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'POST' || !isLoopbackAddress(req.socket?.remoteAddress) || !safeToken(req.headers?.['x-isaac-internal-token'], expectedToken)) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND' })
    }
    const action = String(req.body?.action || '')
    const result = action === 'authorize'
      ? await authorize(String(req.body?.ticket || ''))
      : action === 'revalidate'
        ? await revalidate(String(req.body?.runtimeSessionId || ''))
        : null
    if (!result) return res.status(401).json({ ok: false, code: 'ISAAC_SESSION_INVALID' })
    return res.status(200).json({ ok: true, session: result })
  }
}

export async function authorizeIsaacStreamTicket(ticket) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(ticket)) return null
  const now = new Date()
  const streamSession = await RuntimeStreamSession.findOneAndUpdate(
    {
      _id: digest(ticket),
      engine: ISAAC_RUNTIME_ENGINE,
      revokedAt: null,
      consumedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { consumedAt: now } },
    { new: true },
  ).lean()
  if (!streamSession) return null
  return validateIsaacRuntimeSession(streamSession.runtimeSessionId, streamSession, now)
}

export async function revalidateIsaacRuntimeSession(runtimeSessionId) {
  if (!/^[a-f0-9]{64}$/.test(runtimeSessionId)) return null
  return validateIsaacRuntimeSession(runtimeSessionId, null, new Date())
}

async function validateIsaacRuntimeSession(runtimeSessionId, streamSession, now) {
  const runtimeSession = await RuntimeSession.findOne({
    _id: runtimeSessionId,
    engine: ISAAC_RUNTIME_ENGINE,
    revokedAt: null,
    expiresAt: { $gt: now },
  }).lean()
  if (!runtimeSession || !runtimeSession.capabilities?.includes('runtime.view')) return null
  if (streamSession && !sameRuntimeScope(streamSession, runtimeSession)) return null
  const [authSession, project] = await Promise.all([
    AuthSession.findOne({
      _id: runtimeSession.authSessionId,
      userId: runtimeSession.userId,
      workspaceId: runtimeSession.workspaceId,
      revokedAt: null,
      expiresAt: { $gt: now },
    }).lean(),
    Project.findOne({
      _id: runtimeSession.projectId,
      workspaceId: runtimeSession.workspaceId,
      activeVersionId: runtimeSession.versionId,
      runtimeEnginePreference: ISAAC_RUNTIME_ENGINE,
      isaacCanaryEnabled: true,
    }).select({ _id: 1 }).lean(),
  ])
  if (!isAuthSessionRecordActive(authSession, now) || !project) return null
  const version = await ProjectVersion.findOne({
    _id: runtimeSession.versionId,
    projectId: runtimeSession.projectId,
  }).select({ schema: 1 }).lean()
  if (!version) return null
  const allowedTagIds = [...new Set((version.schema?.tags || [])
    .map(tag => String(tag?.id || ''))
    .filter(tagId => tagId && tagId.length <= 200))]
  const allowedTagBytes = allowedTagIds.reduce((total, tagId) => total + Buffer.byteLength(tagId), 0)
  if (allowedTagIds.length > MAX_RUNTIME_TAGS || allowedTagBytes > MAX_RUNTIME_TAG_ID_BYTES) return null
  return {
    runtimeSessionId: String(runtimeSession._id),
    userId: String(runtimeSession.userId),
    workspaceId: String(runtimeSession.workspaceId),
    projectId: String(runtimeSession.projectId),
    versionId: String(runtimeSession.versionId),
    capabilities: [...new Set((runtimeSession.capabilities || []).map(String).filter(value => value && value.length <= 200))],
    allowedTagIds,
    expiresAt: new Date(runtimeSession.expiresAt).toISOString(),
  }
}

function sameRuntimeScope(streamSession, runtimeSession) {
  return String(streamSession.runtimeSessionId) === String(runtimeSession._id)
    && String(streamSession.userId) === String(runtimeSession.userId)
    && String(streamSession.workspaceId) === String(runtimeSession.workspaceId)
    && String(streamSession.projectId) === String(runtimeSession.projectId)
    && String(streamSession.versionId) === String(runtimeSession.versionId)
}

function safeToken(received, expected) {
  const left = Buffer.from(String(received || ''))
  const right = Buffer.from(String(expected || ''))
  return right.length >= 32 && left.length === right.length && timingSafeEqual(left, right)
}

function isLoopbackAddress(value) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(value || '').toLowerCase())
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}
