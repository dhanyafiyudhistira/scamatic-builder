import { connectMongo, runMongoTransaction } from '../_lib/mongo.js'
import { AuditEvent, CommandEvent, Connector, ConnectorEnvironment, ConnectorHealthEvent, ConnectorSecret, Project, ProjectDraft, ProjectMember, ProjectUnlockSession, ProjectVersion, RuntimeSession, RuntimeStreamSession, ScadaAsset, SimulationResponderLease, SimulationRpcLifecycle, TagValueSnapshot, Telemetry, User } from '../_lib/models.js'
import { requirePrincipal, verifyPassword } from '../_lib/auth.js'
import { accessibleProjectFilter, PERMISSIONS, requireProjectPermission, requireWorkspacePermission } from '../_lib/authorization.js'
import { requireCsrf } from '../_lib/auth.js'
import { createProjectSchema } from '../../shared/project-schema.js'
import { deleteProjectChartTelemetry } from '../_lib/chart-telemetry-store.js'
import { loadWorkspaceChartStorage } from '../_lib/chart-storage-configuration.js'
import { enforceRateLimit } from '../_lib/security.js'
import { grantProjectUnlock, hashProjectPin, projectPinError, projectSecuritySnapshot, revokeProjectUnlock, revokeProjectUnlocks, unlockedProjectIds, verifyProjectPin } from '../_lib/project-pin.js'

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export default async function handler(req, res) {
  const principal = await requirePrincipal(req, res)
  if (!principal) return

  try {
    await connectMongo()
    if (req.method === 'GET') {
      const { id } = req.query || {}
      if (id) {
        if (!requireWorkspacePermission(principal, res, PERMISSIONS.BUILDER_READ)) return
        const project = await Project.findById(id).lean()
        if (!project || !(await requireProjectPermission(principal, res, project, PERMISSIONS.BUILDER_READ))) return
        return res.status(200).json({ project: toClientProject(project, true) })
      }
      // The home directory serves both Builder users and runtime-only operators.
      // ProjectMember assignments still constrain the query for OPERATOR/VIEWER.
      if (!requireWorkspacePermission(principal, res, PERMISSIONS.RUNTIME_VIEW)) return
      const projects = await Project.find(await accessibleProjectFilter(principal)).sort({ updatedAt: -1 }).lean()
      const unlocked = await unlockedProjectIds(principal, projects)
      return res.status(200).json({ projects: projects.map(project => toClientProject(project, unlocked.has(String(project._id)))) })
    }

    if (req.method === 'POST') {
      if (!requireWorkspacePermission(principal, res, PERMISSIONS.PROJECT_CREATE) || !requireCsrf(req, res, principal)) return
      const { name, slug, description = '', width = 1920, height = 1080 } = req.body || {}
      const normalizedName = String(name || '').trim()
      const normalizedSlug = String(slug || '').trim().toLowerCase()
      const canvasWidth = Number(width)
      const canvasHeight = Number(height)
      if (normalizedName.length < 2 || normalizedName.length > 80) {
        return res.status(400).json({ error: 'Project name must contain 2–80 characters.' })
      }
      if (!slugPattern.test(normalizedSlug) || normalizedSlug.length > 80) {
        return res.status(400).json({ error: 'Slug must use lowercase letters, numbers, and hyphens.' })
      }
      if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight) || canvasWidth < 320 || canvasHeight < 240 || canvasWidth > 10000 || canvasHeight > 10000) {
        return res.status(400).json({ error: 'Canvas dimensions must be between 320 × 240 and 10000 × 10000.' })
      }

      const project = await Project.create({
        workspaceId: principal.workspaceId,
        name: normalizedName,
        slug: normalizedSlug,
        description: String(description).slice(0, 500),
        canvas: { width: canvasWidth, height: canvasHeight, background: '#101418' },
        createdBy: principal.id,
        updatedBy: principal.id,
      })
      const schema = createProjectSchema({ id: project.id, name: project.name, slug: project.slug, width: canvasWidth, height: canvasHeight })
      await ProjectDraft.create({ _id: project.id, schema, revision: 1, updatedBy: principal.id })
      await AuditEvent.create({ workspaceId: principal.workspaceId, projectId: project.id, actorId: principal.id, action: 'project.create', targetType: 'project', targetId: project.id })
      return res.status(201).json({ project: toClientProject(project.toObject(), true), revision: 1 })
    }

    if (req.method === 'PATCH') {
      if (!requireCsrf(req, res, principal)) return
      const projectId = String(req.query?.id || req.body?.projectId || '')
      const action = String(req.body?.action || '')
      const project = action === 'unlock'
        ? await Project.findById(projectId).select('+security.pinHash')
        : await Project.findById(projectId)
      if (!project) return res.status(404).json({ error: 'Project not found.' })

      if (action === 'unlock') {
        if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.RUNTIME_VIEW, { bypassProjectLock: true }))) return
        if (!project.security?.pinEnabled || !project.security?.pinHash) return res.status(409).json({ error: 'Project PIN is not configured.', code: 'PROJECT_PIN_NOT_CONFIGURED' })
        if (!(await enforceRateLimit(req, res, 'project-pin-unlock', { limit: 5, windowMs: 15 * 60_000, identity: `${principal.id}:${projectId}` }))) return
        const pin = String(req.body?.pin || '')
        const valid = /^\d{6}$/.test(pin) && await verifyProjectPin(pin, project.security.pinHash)
        if (!valid) {
          await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.pin.unlock.failed', targetType: 'project', targetId: projectId })
          return res.status(403).json({ error: 'Project PIN is incorrect.', code: 'PROJECT_PIN_INVALID' })
        }
        const unlock = await grantProjectUnlock(principal, project)
        await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.pin.unlocked', targetType: 'project', targetId: projectId, metadata: { expiresAt: unlock.expiresAt } })
        return res.status(200).json({ ok: true, security: projectSecuritySnapshot(project, true), unlockExpiresAt: unlock.expiresAt })
      }

      if (action === 'lock') {
        if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.RUNTIME_VIEW, { bypassProjectLock: true }))) return
        await revokeProjectUnlock(principal, projectId)
        await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.pin.locked', targetType: 'project', targetId: projectId })
        return res.status(200).json({ ok: true, security: projectSecuritySnapshot(project, false) })
      }

      const recoversPin = action === 'recover-pin'
      if (!(await requireProjectPermission(principal, res, project, PERMISSIONS.PROJECT_MANAGE, { bypassProjectLock: recoversPin }))) return

      if (recoversPin) {
        const validationError = projectPinError(req.body?.pin, req.body?.confirmPin)
        if (validationError) return res.status(400).json({ error: validationError, code: 'PROJECT_PIN_INVALID_FORMAT' })
        if (!project.security?.pinEnabled) return res.status(409).json({ error: 'Project PIN is not configured.', code: 'PROJECT_PIN_NOT_CONFIGURED' })
        if (!(await enforceRateLimit(req, res, 'project-pin-recovery', { limit: 5, windowMs: 15 * 60_000, identity: `${principal.id}:${projectId}` }))) return
        const user = await User.findById(principal.id).select('+passwordHash')
        const passwordValid = user?.status === 'active' && await verifyPassword(String(req.body?.password || ''), user.passwordHash)
        if (!passwordValid) {
          await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.pin.recovery.failed', targetType: 'project', targetId: projectId })
          return res.status(403).json({ error: 'Account password is incorrect.', code: 'PROJECT_PIN_RECOVERY_DENIED' })
        }
        const pinHash = await hashProjectPin(req.body.pin)
        project.security = {
          pinEnabled: true,
          pinHash,
          pinVersion: Number(project.security?.pinVersion || 0) + 1,
          pinConfiguredAt: new Date(),
          pinConfiguredBy: principal.id,
        }
        project.updatedBy = principal.id
        await project.save()
        await revokeProjectUnlocks(projectId)
        const unlock = await grantProjectUnlock(principal, project)
        await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.pin.recovered', targetType: 'project', targetId: projectId, metadata: { pinVersion: project.security.pinVersion } })
        return res.status(200).json({ ok: true, project: toClientProject(project.toObject(), true), unlockExpiresAt: unlock.expiresAt })
      }

      if (action === 'set-pin') {
        const validationError = projectPinError(req.body?.pin, req.body?.confirmPin)
        if (validationError) return res.status(400).json({ error: validationError, code: 'PROJECT_PIN_INVALID_FORMAT' })
        const pinHash = await hashProjectPin(req.body.pin)
        project.security = {
          pinEnabled: true,
          pinHash,
          pinVersion: Number(project.security?.pinVersion || 0) + 1,
          pinConfiguredAt: new Date(),
          pinConfiguredBy: principal.id,
        }
        project.updatedBy = principal.id
        await project.save()
        await revokeProjectUnlocks(projectId)
        const unlock = await grantProjectUnlock(principal, project)
        await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.pin.configured', targetType: 'project', targetId: projectId, metadata: { pinVersion: project.security.pinVersion } })
        return res.status(200).json({ ok: true, project: toClientProject(project.toObject(), true), unlockExpiresAt: unlock.expiresAt })
      }

      if (action === 'remove-pin') {
        if (!project.security?.pinEnabled) return res.status(409).json({ error: 'Project PIN is not configured.', code: 'PROJECT_PIN_NOT_CONFIGURED' })
        project.security = {
          pinEnabled: false,
          pinHash: null,
          pinVersion: Number(project.security?.pinVersion || 0) + 1,
          pinConfiguredAt: null,
          pinConfiguredBy: null,
        }
        project.updatedBy = principal.id
        await project.save()
        await revokeProjectUnlocks(projectId)
        await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.pin.removed', targetType: 'project', targetId: projectId })
        return res.status(200).json({ ok: true, project: toClientProject(project.toObject(), true) })
      }

      if (action === 'rename') {
        const name = String(req.body?.name || '').trim()
        if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Project name must contain 2–80 characters.' })
        const previousName = project.name
        const renamed = await runMongoTransaction(async session => {
          const options = session ? { session } : {}
          const updatedProject = await Project.findOneAndUpdate(
            { _id: projectId, workspaceId: principal.workspaceId },
            { $set: { name, updatedBy: principal.id } },
            { new: true, ...options },
          ).lean()
          const updatedDraft = await ProjectDraft.findOneAndUpdate(
            { _id: projectId },
            { $set: { 'schema.project.name': name, updatedBy: principal.id }, $inc: { revision: 1 } },
            { new: true, ...options },
          ).lean()
          await AuditEvent.create([{ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: 'project.rename', targetType: 'project', targetId: projectId, metadata: { previousName, name } }], options)
          return { project: updatedProject, revision: updatedDraft?.revision || null }
        })
        return res.status(200).json({ ok: true, project: toClientProject(renamed.project, true), revision: renamed.revision })
      }

      if (action === 'hide' || action === 'unhide') {
        project.hiddenAt = action === 'hide' ? new Date() : null
        project.updatedBy = principal.id
        await project.save()
        await AuditEvent.create({ workspaceId: principal.workspaceId, projectId, actorId: principal.id, action: `project.${action}`, targetType: 'project', targetId: projectId })
        return res.status(200).json({ ok: true, project: toClientProject(project.toObject(), true) })
      }

      return res.status(400).json({ error: 'Unsupported project action.' })
    }

    if (req.method === 'DELETE') {
      if (!requireCsrf(req, res, principal)) return
      const projectId = String(req.query?.id || req.body?.projectId || '')
      const project = await Project.findById(projectId)
      if (!project || !(await requireProjectPermission(principal, res, project, PERMISSIONS.PROJECT_DELETE))) return
      if (String(req.body?.confirmSlug || '') !== project.slug) return res.status(400).json({ error: 'confirmSlug must match the project slug.' })
      const connectors = await Connector.find({ projectId }).select({ _id: 1 }).lean()
      const connectorIds = connectors.map(item => item._id)
      await Promise.all([
        RuntimeSession.deleteMany({ projectId }),
        RuntimeStreamSession.deleteMany({ projectId }),
        SimulationResponderLease.deleteMany({ projectId }),
        SimulationRpcLifecycle.deleteMany({ projectId }),
        CommandEvent.deleteMany({ projectId }),
        Telemetry.deleteMany({ projectId }),
        TagValueSnapshot.deleteMany({ projectId }),
        ConnectorHealthEvent.deleteMany({ projectId }),
        ConnectorEnvironment.deleteMany({ projectId }),
        ConnectorSecret.deleteMany({ connectorId: { $in: connectorIds } }),
        Connector.deleteMany({ projectId }),
        AuditEvent.deleteMany({ projectId }),
        ProjectVersion.deleteMany({ projectId }),
        ScadaAsset.deleteMany({ projectId }),
        ProjectMember.deleteMany({ projectId }),
        ProjectUnlockSession.deleteMany({ projectId }),
        ProjectDraft.deleteOne({ _id: projectId }),
      ])
      await Project.deleteOne({ _id: projectId })
      let telemetryCleanup = 'not-configured'
      let chartStorage = null
      try { chartStorage = await loadWorkspaceChartStorage(principal.workspaceId) } catch { telemetryCleanup = 'configuration-invalid' }
      if (chartStorage?.config.enabled) {
        try {
          await deleteProjectChartTelemetry({ workspaceId: principal.workspaceId, projectId }, { config: chartStorage.config })
          telemetryCleanup = 'completed'
        } catch (cleanupError) {
          telemetryCleanup = 'pending'
          console.error(JSON.stringify({ level: 'warn', event: 'chart.telemetry.cleanup.failed', projectId, errorCode: cleanupError?.code || 'CHART_STORAGE_UNAVAILABLE' }))
        }
      }
      await AuditEvent.create({ workspaceId: principal.workspaceId, actorId: principal.id, action: 'project.deleted', targetType: 'project', targetId: projectId, metadata: { slug: project.slug, telemetryCleanup } })
      return res.status(200).json({ ok: true })
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'Project slug already exists in this workspace.' })
    return res.status(500).json({ error: 'Unable to process project request.' })
  }
}

function toClientProject(project, unlocked = false) {
  return {
    id: project._id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    canvas: project.canvas,
    svgAssetId: project.svgAssetId,
    activeVersionId: project.activeVersionId,
    hiddenAt: project.hiddenAt || null,
    security: projectSecuritySnapshot(project, unlocked),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}
