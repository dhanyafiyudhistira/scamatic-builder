import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRequest, login, logout } from './platform/api'
import { RuntimeCanvas } from './platform/RuntimeCanvas'
import { ThemeToneToggle, useThemeTone } from './platform/ThemeTone'
import { BoardToneToggle, useBoardTone } from './platform/BoardTone'
import { useEditorHistory } from './platform/useEditorHistory'
import { ComponentInspector, ComponentLibrary, LayersPanel, MockControls, TagManager } from './platform/BuilderPanels'
import { COMPONENT_REGISTRY, compatibleTags, createComponentInstance } from '../shared/component-registry.js'
import { executeMockCommand, initialMockValue } from '../shared/runtime-evaluator.js'
import { validateProjectSchema } from '../shared/project-schema.js'
import { applyNodeRedImportPlan } from '../shared/node-red-import.js'
import { createNodeRedExport, serializeNodeRedExport } from '../shared/node-red-export.js'
import { arrangeSelection, moveSelection } from '../shared/placement.js'
import { describeVersion, nextVersionNumber } from '../shared/version-history.js'
import { auditActionCategory, auditActionLabel } from '../shared/audit-display.js'
import { ConnectorManager, FlowImportModal } from './platform/ConnectorManager.jsx'
import { ChartStorageManager } from './platform/ChartStorageManager.jsx'
import { assignControlToPopup, copySafeComponent, detachControlFromPopup, removeComponentsAndCleanPopups, reorderPopupControl } from '../shared/control-popup.js'
import { RUNTIME_PROFILES, runtimeProfileMetadata } from '../shared/runtime-profile.js'
import { RuntimeProfileBanner, RuntimeProfileSelector } from './platform/RuntimeProfile.jsx'
import { validationNoticeDetails } from '../shared/validation-notice.js'
import { encodeHardPassword } from '../shared/hard-password.js'

const makeId = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`
const recoveryKey = projectId => `scamatic.recovery.${projectId}`
const componentTypeCount = Object.values(COMPONENT_REGISTRY).filter(definition => definition.library !== false).length
const sidebarLayoutKey = 'scamatic.builder.sidebar-widths'
const SIDEBAR_LIMITS = Object.freeze({
  left: { min: 260, max: 650 },
  right: { min: 280, max: 700 },
})

function initialSidebarWidths() {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(sidebarLayoutKey) || 'null')
    return {
      left: clampSidebarWidth('left', stored?.left),
      right: clampSidebarWidth('right', stored?.right),
    }
  } catch {
    return { left: SIDEBAR_LIMITS.left.min, right: SIDEBAR_LIMITS.right.min }
  }
}

function clampSidebarWidth(side, value) {
  const limits = SIDEBAR_LIMITS[side]
  const width = Number(value)
  return Math.max(limits.min, Math.min(limits.max, Number.isFinite(width) ? Math.round(width) : limits.min))
}

function persistSidebarWidths(widths) {
  try { globalThis.localStorage?.setItem(sidebarLayoutKey, JSON.stringify(widths)) } catch { /* Storage can be unavailable in private contexts. */ }
}

export default function BuilderPlatform() {
  const [session, setSession] = useState({ loading: true, user: null })
  const [projects, setProjects] = useState([])
  const [currentProject, setCurrentProject] = useState(null)
  const editor = useEditorHistory(null)
  const draft = editor.value
  const draftRef = useRef(draft)
  const clipboardRef = useRef([])
  const savingRef = useRef(false)
  const sidebarWidthsRef = useRef(null)
  const sidebarResizeCleanupRef = useRef(null)
  const [sidebarWidths, setSidebarWidths] = useState(initialSidebarWidths)
  const [revision, setRevision] = useState(null)
  const [svg, setSvg] = useState(null)
  const [designAssets, setDesignAssets] = useState({})
  const [selectedIds, setSelectedIds] = useState([])
  const [mockValues, setMockValues] = useState({})
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const [preview, setPreview] = useState(false)
  const [snapToGrid, setSnapToGrid] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [showRulers, setShowRulers] = useState(false)
  const [smartGuides, setSmartGuides] = useState(true)
  const [gridSize, setGridSize] = useState(20)
  const [zoom, setZoom] = useState(1)
  const [boardTone, setBoardTone] = useBoardTone()
  const [themeTone, setThemeTone] = useThemeTone()
  const [autoSave, setAutoSave] = useState(true)
  const [commandMessage, setCommandMessage] = useState('')
  const [lastSavedAt, setLastSavedAt] = useState(null)
  const [versions, setVersions] = useState([])
  const [auditEvents, setAuditEvents] = useState([])
  const [flowImportOpen, setFlowImportOpen] = useState(false)

  useEffect(() => { draftRef.current = draft }, [draft])
  useEffect(() => { sidebarWidthsRef.current = sidebarWidths }, [sidebarWidths])
  useEffect(() => () => sidebarResizeCleanupRef.current?.(), [])

  const updateSidebarWidth = useCallback((side, width, persist = false) => {
    setSidebarWidths(previous => {
      const next = { ...previous, [side]: clampSidebarWidth(side, width) }
      sidebarWidthsRef.current = next
      if (persist) persistSidebarWidths(next)
      return next
    })
  }, [])

  const startSidebarResize = useCallback((side, event) => {
    if (event.button !== 0) return
    event.preventDefault()
    sidebarResizeCleanupRef.current?.()
    const startX = event.clientX
    const startWidth = sidebarWidthsRef.current?.[side] || SIDEBAR_LIMITS[side].min
    const move = moveEvent => {
      const delta = side === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX
      updateSidebarWidth(side, startWidth + delta)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      document.body.classList.remove('sb-is-resizing-sidebar')
      sidebarResizeCleanupRef.current = null
    }
    const finish = () => {
      persistSidebarWidths(sidebarWidthsRef.current)
      cleanup()
    }
    document.body.classList.add('sb-is-resizing-sidebar')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    sidebarResizeCleanupRef.current = cleanup
  }, [updateSidebarWidth])

  const resizeSidebarByKeyboard = useCallback((side, event) => {
    const current = sidebarWidthsRef.current?.[side] || SIDEBAR_LIMITS[side].min
    let next
    if (event.key === 'Home') next = SIDEBAR_LIMITS[side].min
    else if (event.key === 'End') next = SIDEBAR_LIMITS[side].max
    else if (side === 'left' && event.key === 'ArrowLeft') next = current - 16
    else if (side === 'left' && event.key === 'ArrowRight') next = current + 16
    else if (side === 'right' && event.key === 'ArrowLeft') next = current + 16
    else if (side === 'right' && event.key === 'ArrowRight') next = current - 16
    else return
    event.preventDefault()
    updateSidebarWidth(side, next, true)
  }, [updateSidebarWidth])

  const loadSession = useCallback(async () => {
    try {
      const data = await apiRequest('/api/auth')
      setSession({ loading: false, user: data.user })
    } catch {
      setSession({ loading: false, user: null })
    }
  }, [])
  useEffect(() => { loadSession() }, [loadSession])

  const loadProjects = useCallback(async () => {
    const data = await apiRequest('/api/projects')
    setProjects(data.projects)
  }, [])
  useEffect(() => {
    if (session.user) loadProjects().catch(error => setNotice({ type: 'error', text: error.message }))
  }, [session.user, loadProjects])

  const openProject = async project => {
    setBusy(true)
    try {
      const data = await apiRequest(`/api/draft?projectId=${encodeURIComponent(project.id)}`)
      let schema = data.schema
      let recovered = false
      try {
        const local = JSON.parse(localStorage.getItem(recoveryKey(project.id)) || 'null')
        if (local?.schema && local.revision === data.revision && JSON.stringify(local.schema) !== JSON.stringify(data.schema)) {
          recovered = window.confirm(`Unsaved local recovery from ${new Date(local.timestamp).toLocaleString()} was found. Restore it?`)
          if (recovered) schema = local.schema
        }
      } catch { localStorage.removeItem(recoveryKey(project.id)) }

      setCurrentProject(project)
      editor.replace(schema)
      setRevision(data.revision)
      setSvg(data.svg)
      setDesignAssets(data.designAssets || {})
      setSelectedIds([])
      setDirty(recovered)
      setMockValues(Object.fromEntries((schema.tags || []).map(tag => [tag.id, initialMockValue(tag)])))
      setNotice(recovered ? { type: 'info', text: 'Local recovery restored. Autosave will persist it.' } : null)
      loadGovernance(project.id).catch(() => { })
    } catch (error) {
      setNotice({ type: 'error', text: error.message, details: validationNoticeDetails(error.issues) })
    } finally {
      setBusy(false)
    }
  }

  const loadGovernance = async projectId => {
    const versionData = await apiRequest(`/api/versions?projectId=${encodeURIComponent(projectId)}`)
    setVersions(versionData.versions || [])
    if (session.user?.capabilities?.includes('audit.read')) {
      const auditData = await apiRequest(`/api/audit?projectId=${encodeURIComponent(projectId)}&limit=12`)
      setAuditEvents(auditData.events || [])
    } else setAuditEvents([])
  }

  const changeDraft = useCallback((updater, { transient = false } = {}) => {
    if (transient) editor.mutate(updater)
    else editor.commit(updater)
    setDirty(true)
  }, [editor.commit, editor.mutate])

  const updateComponent = useCallback((componentId, patch, options) => {
    changeDraft(previous => ({
      ...previous,
      components: previous.components.map(component => component.id === componentId
        ? {
          ...component,
          ...patch,
          position: patch.position || component.position,
          properties: patch.properties || component.properties,
          binding: patch.binding || component.binding,
        }
        : component),
    }), options)
  }, [changeDraft])

  const selectComponent = useCallback((componentId, { additive = false } = {}) => {
    if (!componentId) return setSelectedIds([])
    setSelectedIds(previous => {
      if (!additive) return [componentId]
      return previous.includes(componentId) ? previous.filter(id => id !== componentId) : [...previous, componentId]
    })
  }, [])

  const addComponent = useCallback(type => {
    if (!draftRef.current) return
    const schema = draftRef.current
    const candidates = compatibleTags(type, schema.tags)
    const tag = ['control-button', 'tuning-slider', 'operation-shifter'].includes(type)
      ? candidates.find(item => ['write', 'read-write'].includes(item.access))
      : candidates[0]
    const component = createComponentInstance(type, { id: makeId('cmp'), canvas: schema.project.canvas, tagId: tag?.id || null, index: schema.components.length })
    changeDraft(previous => ({ ...previous, components: [...previous.components, component] }))
    setSelectedIds([component.id])
  }, [changeDraft])

  const addDesignElement = useCallback((asset, dropPoint = null) => {
    if (!draftRef.current || !asset?.id) return
    const schema = draftRef.current
    const component = createComponentInstance('design-image', { id: makeId('cmp'), canvas: schema.project.canvas, index: schema.components.length })
    const ratio = Number(asset.width) > 0 && Number(asset.height) > 0 ? asset.width / asset.height : 4 / 3
    let width = Math.min(360, schema.project.canvas.width * .4)
    let height = width / ratio
    if (height > schema.project.canvas.height * .4) {
      height = schema.project.canvas.height * .4
      width = height * ratio
    }
    width = Math.max(48, Math.min(width, schema.project.canvas.width))
    height = Math.max(48, Math.min(height, schema.project.canvas.height))
    const centerX = dropPoint?.x ?? schema.project.canvas.width / 2
    const centerY = dropPoint?.y ?? schema.project.canvas.height / 2
    component.name = asset.name || component.name
    component.position = {
      ...component.position,
      width,
      height,
      x: Math.max(0, Math.min(schema.project.canvas.width - width, centerX - width / 2)),
      y: Math.max(0, Math.min(schema.project.canvas.height - height, centerY - height / 2)),
    }
    component.properties = { ...component.properties, assetId: asset.id, fileName: asset.name || 'Custom element' }
    setDesignAssets(previous => ({ ...previous, [asset.id]: asset }))
    changeDraft(previous => ({ ...previous, components: [...previous.components, component] }))
    setSelectedIds([component.id])
    setNotice({ type: 'success', text: `${asset.name || 'Custom element'} added to the canvas.` })
  }, [changeDraft])

  const dropDesignElement = useCallback(async (file, point) => {
    if (!currentProject) return
    setNotice({ type: 'info', text: `Uploading ${file.name}…` })
    try {
      const asset = await uploadDesignElementFile(currentProject.id, file)
      addDesignElement(asset, point)
    } catch (error) {
      setNotice({ type: 'error', text: error.message })
    }
  }, [addDesignElement, currentProject])

  const deleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return
    const selected = new Set(selectedIds)
    changeDraft(previous => ({ ...previous, components: removeComponentsAndCleanPopups(previous.components, selected) }))
    setSelectedIds([])
  }, [changeDraft, selectedIds])

  const duplicateSelected = useCallback(() => {
    const schema = draftRef.current
    if (!schema || selectedIds.length === 0) return
    const selected = new Set(selectedIds)
    const copies = schema.components.filter(component => selected.has(component.id)).map((component, index) => ({
      ...structuredClone(copySafeComponent(component)),
      id: makeId('cmp'),
      name: `${component.name} copy`,
      position: { ...component.position, x: component.position.x + 20 + index * 5, y: component.position.y + 20 + index * 5 },
      zIndex: schema.components.length + index + 1,
    }))
    changeDraft(previous => ({ ...previous, components: [...previous.components, ...copies] }))
    setSelectedIds(copies.map(component => component.id))
  }, [changeDraft, selectedIds])

  const copySelected = useCallback(() => {
    const schema = draftRef.current
    if (!schema) return
    const selected = new Set(selectedIds)
    clipboardRef.current = schema.components.filter(component => selected.has(component.id)).map(component => structuredClone(component))
  }, [selectedIds])

  const pasteComponents = useCallback(() => {
    const schema = draftRef.current
    if (!schema || clipboardRef.current.length === 0) return
    const copies = clipboardRef.current.map((component, index) => ({
      ...structuredClone(copySafeComponent(component)), id: makeId('cmp'), name: `${component.name} copy`,
      position: { ...component.position, x: component.position.x + 30 + index * 5, y: component.position.y + 30 + index * 5 },
      zIndex: schema.components.length + index + 1,
    }))
    changeDraft(previous => ({ ...previous, components: [...previous.components, ...copies] }))
    setSelectedIds(copies.map(component => component.id))
  }, [changeDraft])

  const reorderComponent = useCallback((componentId, direction) => {
    const schema = draftRef.current
    const component = schema?.components.find(item => item.id === componentId)
    if (!component) return
    updateComponent(componentId, { zIndex: Math.max(1, (component.zIndex || 1) + direction) })
  }, [updateComponent])

  const addExistingPopupControl = useCallback((popupId, childId) => {
    changeDraft(previous => ({ ...previous, components: assignControlToPopup(previous.components, popupId, childId) }))
  }, [changeDraft])

  const createPopupControl = useCallback((popupId, type) => {
    if (!['control-button', 'tuning-slider'].includes(type) || !draftRef.current) return
    const schema = draftRef.current
    const tag = compatibleTags(type, schema.tags).find(item => ['write', 'read-write'].includes(item.access))
    const component = createComponentInstance(type, { id: makeId('cmp'), canvas: schema.project.canvas, tagId: tag?.id || null, index: schema.components.length })
    changeDraft(previous => {
      const components = [...previous.components, component]
      return { ...previous, components: assignControlToPopup(components, popupId, component.id) }
    })
    setSelectedIds([component.id])
  }, [changeDraft])

  const detachPopupControl = useCallback((popupId, childId) => {
    changeDraft(previous => ({ ...previous, components: detachControlFromPopup(previous.components, popupId, childId) }))
    setSelectedIds([childId])
  }, [changeDraft])

  const movePopupControl = useCallback((popupId, childId, direction) => {
    changeDraft(previous => ({ ...previous, components: reorderPopupControl(previous.components, popupId, childId, direction) }))
  }, [changeDraft])

  const undo = useCallback(() => { editor.undo(); setDirty(true) }, [editor.undo])
  const redo = useCallback(() => { editor.redo(); setDirty(true) }, [editor.redo])
  const nudgeSelected = useCallback((dx, dy) => {
    if (selectedIds.length === 0) return
    changeDraft(previous => ({
      ...previous,
      components: moveSelection(previous.components, selectedIds, dx, dy, previous.project.canvas),
    }))
  }, [changeDraft, selectedIds])
  const arrangeSelected = useCallback(action => {
    if (selectedIds.length < 2) return
    changeDraft(previous => ({ ...previous, components: arrangeSelection(previous.components, selectedIds, action) }))
  }, [changeDraft, selectedIds])

  useEffect(() => {
    if (!draft || preview) return
    const onKey = event => {
      const target = event.target
      if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
      else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
      else if (modifier && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelected() }
      else if (modifier && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteComponents() }
      else if (modifier && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected() }
      else if (modifier && (event.key === '=' || event.key === '+')) { event.preventDefault(); setZoom(value => Math.min(2, value + .1)) }
      else if (modifier && event.key === '-') { event.preventDefault(); setZoom(value => Math.max(.5, value - .1)) }
      else if (modifier && event.key === '0') { event.preventDefault(); setZoom(1) }
      else if (!modifier && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
        const step = event.shiftKey ? gridSize : 1
        nudgeSelected(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0)
      }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, preview, undo, redo, copySelected, pasteComponents, duplicateSelected, deleteSelected, nudgeSelected, gridSize])

  useEffect(() => {
    if (!dirty || !draft || !currentProject) return
    localStorage.setItem(recoveryKey(currentProject.id), JSON.stringify({ schema: draft, revision, timestamp: Date.now() }))
  }, [dirty, draft, revision, currentProject])

  const saveDraft = useCallback(async ({ silent = false } = {}) => {
    const snapshot = draftRef.current
    if (!snapshot || !currentProject || savingRef.current) return null
    savingRef.current = true
    if (!silent) { setBusy(true); setNotice({ type: 'info', text: 'Saving draft…' }) }
    try {
      const data = await apiRequest(`/api/draft?projectId=${encodeURIComponent(currentProject.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ projectId: currentProject.id, schema: snapshot, revision }),
      })
      setRevision(data.revision)
      setLastSavedAt(new Date())
      if (draftRef.current === snapshot) {
        setDirty(false)
        localStorage.removeItem(recoveryKey(currentProject.id))
      }
      if (!silent) setNotice({ type: 'success', text: `Draft saved · revision ${data.revision}` })
      return data.revision
    } catch (error) {
      setNotice({ type: 'error', text: error.message })
      return null
    } finally {
      savingRef.current = false
      if (!silent) setBusy(false)
    }
  }, [currentProject, revision])

  useEffect(() => {
    if (!autoSave || !dirty || !draft || !currentProject || busy) return
    const timer = window.setTimeout(() => saveDraft({ silent: true }), 1800)
    return () => window.clearTimeout(timer)
  }, [autoSave, dirty, draft, currentProject, busy, saveDraft])

  const publish = async () => {
    let publishRevision = revision
    if (dirty) {
      const saved = await saveDraft()
      if (!saved) return
      publishRevision = saved
    }
    setBusy(true)
    setNotice({ type: 'info', text: 'Validating and publishing…' })
    try {
      const data = await apiRequest('/api/publish', { method: 'POST', body: JSON.stringify({ projectId: currentProject.id, expectedDraftRevision: publishRevision, idempotencyKey: globalThis.crypto.randomUUID(), message: `Published revision ${publishRevision}` }) })
      setNotice({ type: 'success', text: `Published version ${data.version} · ${data.checksum.slice(0, 10)}` })
      setCurrentProject(previous => ({ ...previous, activeVersionId: data.versionId }))
      await loadProjects()
      await loadGovernance(currentProject.id)
    } catch (error) {
      setNotice({ type: 'error', text: error.message, details: validationNoticeDetails(error.issues) })
    } finally { setBusy(false) }
  }

  const restoreVersion = async version => {
    const nextVersion = nextVersionNumber(versions)
    if (!window.confirm(`Create v${nextVersion} from published v${version.version} and make v${nextVersion} active?\n\nHistory remains immutable: v${version.version} stays unchanged and the draft is not modified.`)) return
    setBusy(true)
    try {
      const data = await apiRequest('/api/versions', { method: 'POST', body: JSON.stringify({ projectId: currentProject.id, versionId: version.id, idempotencyKey: globalThis.crypto.randomUUID(), message: `Restored from v${version.version}` }) })
      setCurrentProject(previous => ({ ...previous, activeVersionId: data.version.id }))
      setNotice({ type: 'success', text: `v${data.version.version} is now ACTIVE · restored from v${version.version}. v${version.version} remains in history; draft unchanged.` })
      await loadGovernance(currentProject.id)
    } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  const runMockCommand = useCallback(async (component, tag, requestedValue) => {
    const result = executeMockCommand(component, tag, mockValues[tag.id], requestedValue, { components: draftRef.current?.components || [] })
    if (result.ok) {
      setMockValues(previous => ({ ...previous, [tag.id]: result.value }))
      if (result.resetAfterMs) window.setTimeout(() => setMockValues(previous => ({ ...previous, [tag.id]: false })), result.resetAfterMs)
    }
    setCommandMessage(result.message)
    window.setTimeout(() => setCommandMessage(''), 1800)
    return result
  }, [mockValues])

  const changeRuntimeProfile = useCallback(nextProfile => {
    if (!RUNTIME_PROFILES.includes(nextProfile) || nextProfile === draftRef.current?.project?.runtimeProfile) return
    if (nextProfile === 'real' && !window.confirm('Switch this draft to REAL PLC? Published controls can actuate physical equipment through ThingsBoard and the edge gateway.')) return
    changeDraft(previous => ({
      ...previous,
      project: { ...previous.project, runtimeProfile: nextProfile },
    }))
  }, [changeDraft])

  const handleLogout = async () => {
    await logout().catch(() => { })
    setSession({ loading: false, user: null }); setCurrentProject(null); editor.replace(null)
  }
  const closeProject = () => { setCurrentProject(null); editor.replace(null); setSelectedIds([]); setDesignAssets({}) }

  const exportNodeRedFlow = () => {
    try {
      const result = createNodeRedExport(draftRef.current)
      const url = URL.createObjectURL(new Blob([serializeNodeRedExport(result)], { type: 'application/json;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.fileName
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      setNotice({ type: 'success', text: `Node-RED flow exported: ${result.stats.tags} tags, ${result.stats.dashboardNodes} dashboard nodes, no credentials, and ${result.warnings.length} embedded setup note${result.warnings.length === 1 ? '' : 's'}.` })
    } catch (exportError) {
      setNotice({ type: 'error', text: exportError.message })
    }
  }

  if (session.loading) return <CenteredState title="Loading session…" />
  if (!session.user) return <LoginScreen onAuthenticated={loadSession} />
  if (!currentProject || !draft) return <ProjectHome user={session.user} projects={projects} busy={busy} onOpen={openProject} onCreated={async project => { await loadProjects(); await openProject(project) }} onProjectsChanged={loadProjects} onNotice={setNotice} onLogout={handleLogout} notice={notice} />

  if (preview) {
    const previewProfile = runtimeProfileMetadata(draft)
    return <div className="sb-preview-page"><div className="sb-runtime-toolbar"><div><strong>Draft Preview</strong><span>{previewProfile.label} · revision {revision}</span></div><div className="sb-runtime-toolbar-actions"><BoardToneToggle value={boardTone} onChange={setBoardTone} /><ThemeToneToggle /><button type="button" onClick={() => setPreview(false)}>Back to builder</button></div></div><RuntimeProfileBanner profile={previewProfile} preview /><RuntimeCanvas schema={draft} svg={svg} designAssets={designAssets} values={mockValues} boardTone={boardTone} actorRole={session.user.role} onCommand={previewProfile.commandEnabled ? runMockCommand : undefined} commandConnectionAvailable={previewProfile.commandEnabled} /><MockControls tags={draft.tags} values={mockValues} onChange={setMockValues} message={commandMessage} /></div>
  }

  const selected = selectedIds.length === 1 ? draft.components.find(component => component.id === selectedIds[0]) : null
  const issues = validateProjectSchema(draft, { requireAsset: true })
  const profile = runtimeProfileMetadata(draft)

  return (
    <div className="sb-app">
      <header className="sb-topbar">
        <button type="button" className="sb-brand" onClick={closeProject}>SCAMATIC<span>.BUILDER</span></button>
        <nav className="sb-header-menus" aria-label="Builder menus">
          <FileMenu
            autoSave={autoSave}
            onAutoSaveChange={setAutoSave}
            dirty={dirty}
            revision={revision}
            lastSavedAt={lastSavedAt}
            busy={busy}
            onSave={() => saveDraft()}
            onPreview={() => setPreview(true)}
            canImportFlow={session.user.capabilities?.includes('source.configure')}
            onImportFlow={() => setFlowImportOpen(true)}
            exportFlowDisabled={!draft.tags.length && !draft.components.length}
            onExportFlow={exportNodeRedFlow}
            canPublish={session.user.capabilities?.includes('project.publish')}
            onPublish={publish}
            runtimeHref={currentProject.activeVersionId ? `/runtime/${currentProject.slug}` : null}
          />
          <EditMenu
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            canDuplicate={selectedIds.length > 0}
            onUndo={undo}
            onRedo={redo}
            onDuplicate={duplicateSelected}
          />
          <ViewMenu
            canvas={draft.project.canvas}
            themeTone={themeTone}
            onThemeToneChange={setThemeTone}
            boardTone={boardTone}
            onBoardToneChange={setBoardTone}
            gridSize={gridSize}
            onGridSizeChange={setGridSize}
            showGrid={showGrid}
            onShowGridChange={setShowGrid}
            snapToGrid={snapToGrid}
            onSnapToGridChange={setSnapToGrid}
            smartGuides={smartGuides}
            onSmartGuidesChange={setSmartGuides}
            showRulers={showRulers}
            onShowRulersChange={setShowRulers}
            zoom={zoom}
            onZoomChange={setZoom}
          />
        </nav>
        <div className="sb-project-title"><strong>{currentProject.name}</strong><span>/{currentProject.slug}</span></div>
      </header>
      {notice && <div className={`sb-builder-notice ${notice.type} ${notice.details?.length ? 'has-details' : ''}`} role="status" aria-live={notice.type === 'error' ? 'assertive' : 'polite'}>
        <span>{notice.text}</span>
        {notice.details?.length > 0 && <ul>{notice.details.map((detail, index) => <li className={detail.severity} key={`${detail.path}-${detail.message}-${index}`}><b>{detail.severity === 'warning' ? 'Warning' : 'Error'}</b><span>{detail.message}</span>{detail.path && <code>{detail.path}</code>}</li>)}</ul>}
      </div>}

      <div
        className="sb-builder-grid"
        style={{
          '--sb-left-sidebar-width': `${sidebarWidths.left}px`,
          '--sb-right-sidebar-width': `${sidebarWidths.right}px`,
        }}
      >
        <aside className="sb-sidebar left">
          <Panel title="Components" description={`${componentTypeCount} component types · Controls and indicators`} collapsible defaultOpen={false} storageKey={`scamatic.panel.components.${currentProject.id}`}><ComponentLibrary onAdd={addComponent} /></Panel>
          <Panel title="Schematic Assets" description={`${Object.keys(designAssets).length} custom images · PNG, JPG, or SVG`}>
            <div className="sb-schematic-assets">
              <span className="sb-asset-section-label">Base schematic</span>
              <SvgUploader projectId={currentProject.id} beforeUpload={() => dirty ? saveDraft() : revision} onUploaded={({ svg: nextSvg, assetId, revision: nextRevision }) => { setSvg(nextSvg); setRevision(nextRevision); editor.mutate(previous => ({ ...previous, project: { ...previous.project, svgAssetId: assetId } })); setDirty(false); setNotice({ type: 'success', text: 'SVG sanitized and stored.' }) }} onError={text => setNotice({ type: 'error', text })} />
              <span className="sb-asset-section-label">Design elements</span>
              <DesignElementUploader projectId={currentProject.id} onUploaded={addDesignElement} onError={text => setNotice({ type: 'error', text })} />
              <small>Upload here or drop a file directly onto the board. Each image becomes a movable, resizable layer.</small>
            </div>
          </Panel>
          <Panel title="Data sources" description={`${draft.dataSources.length} sources · Connectors and configuration`} collapsible defaultOpen={false} storageKey={`scamatic.panel.sources.${currentProject.id}`}><ConnectorManager projectId={currentProject.id} schema={draft} onSchemaChange={changeDraft} canConfigure={session.user.capabilities?.includes('source.configure')} canRotateSecret={session.user.capabilities?.includes('secret.rotate')} draftDirty={dirty} onNotice={setNotice} /></Panel>
          {session.user.capabilities?.includes('chart-storage.manage') && <Panel title="Chart storage" description="Isolated MongoDB · Encrypted workspace configuration" collapsible defaultOpen={false} storageKey={`scamatic.panel.chart-storage.${session.user.workspaceId}`}><ChartStorageManager onNotice={setNotice} /></Panel>}
          <Panel title="Tags & simulation" description={`${draft.tags.length} tags · ${profile.label} · Bindings and simulation`} collapsible defaultOpen={false} storageKey={`scamatic.panel.tags.${currentProject.id}`}>
            <div className="sb-tags-simulation-layout">
              <RuntimeProfileSelector value={profile.id} onChange={changeRuntimeProfile} />
              <TagManager schema={draft} values={mockValues} onSchemaChange={changeDraft} onValuesChange={setMockValues} />
            </div>
          </Panel>
          <Panel title="Layers" description={`${draft.components.length} layers · Visibility, locking, and stacking order`} collapsible defaultOpen={false} storageKey={`scamatic.panel.layers.${currentProject.id}`}><LayersPanel components={draft.components} selectedIds={selectedIds} onSelect={selectComponent} onPatch={updateComponent} onReorder={reorderComponent} /></Panel>
          <Panel title={`Validation · ${issues.length}`}>{issues.length === 0 ? <p className="sb-ok">Ready to publish</p> : <ul className="sb-issue-list">{issues.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity}>{issue.message}</li>)}</ul>}</Panel>
        </aside>
        <div
          className="sb-sidebar-resizer left"
          role="separator"
          aria-label="Resize left sidebar"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_LIMITS.left.min}
          aria-valuemax={SIDEBAR_LIMITS.left.max}
          aria-valuenow={sidebarWidths.left}
          tabIndex={0}
          onPointerDown={event => startSidebarResize('left', event)}
          onKeyDown={event => resizeSidebarByKeyboard('left', event)}
        />

        <main className="sb-workspace">
          <RuntimeCanvas schema={draft} svg={svg} designAssets={designAssets} values={mockValues} selectedIds={selectedIds} editable boardTone={boardTone} zoom={zoom} gridSize={gridSize} snapToGrid={snapToGrid} showGrid={showGrid} showRulers={showRulers} smartGuides={smartGuides} onSelect={selectComponent} onChange={updateComponent} onTransformStart={editor.beginTransaction} onTransformEnd={() => { editor.endTransaction(); setDirty(true) }} onDesignFileDrop={dropDesignElement} />
        </main>

        <aside className="sb-sidebar right">
          <Panel title={selectedIds.length > 1 ? `${selectedIds.length} components selected` : 'Properties'}>
            {selected ? <ComponentInspector component={selected} components={draft.components} tags={draft.tags} onChange={patch => updateComponent(selected.id, patch)} onDelete={deleteSelected} onDuplicate={duplicateSelected} onAddPopupChild={addExistingPopupControl} onCreatePopupChild={createPopupControl} onDetachPopupChild={detachPopupControl} onReorderPopupChild={movePopupControl} onSelectChild={childId => selectComponent(childId)} /> : selectedIds.length > 1 ? <MultiSelectionActions count={selectedIds.length} onArrange={arrangeSelected} onDuplicate={duplicateSelected} onDelete={deleteSelected} onLock={() => batchPatch(selectedIds, { locked: true }, changeDraft)} onHide={() => batchPatch(selectedIds, { visible: false }, changeDraft)} /> : <p className="sb-muted">Select a component on the canvas or Layers panel.</p>}
          </Panel>
          <Panel title="Project schema"><dl className="sb-metadata"><div><dt>Version</dt><dd>{draft.schemaVersion}</dd></div><div><dt>Profile</dt><dd>{profile.label}</dd></div><div><dt>Components</dt><dd>{draft.components.length}</dd></div><div><dt>Tags</dt><dd>{draft.tags.length}</dd></div><div><dt>Asset</dt><dd>{draft.project.svgAssetId ? 'Sanitized' : 'Missing'}</dd></div><div><dt>History</dt><dd>{editor.canUndo ? 'Available' : 'Clean'}</dd></div></dl></Panel>
          <Panel title="Published history" description={`${versions.length} snapshots · Publish and restore history`} collapsible defaultOpen={false} storageKey={`scamatic.panel.versions.${currentProject.id}`}><VersionList versions={versions} activeVersionId={currentProject.activeVersionId} canRestore={session.user.capabilities?.includes('project.publish')} onRestore={restoreVersion} /></Panel>
          {session.user.capabilities?.includes('audit.read') && <Panel title="Recent audit" description={`${auditEvents.length} events · Security and command activity`} collapsible defaultOpen={false} storageKey={`scamatic.panel.audit.${currentProject.id}`}><AuditList events={auditEvents} /></Panel>}
          <Panel title="Shortcuts"><div className="sb-shortcuts"><span><kbd>Arrow</kbd> Nudge 1 px</span><span><kbd>Shift + Arrow</kbd> Nudge by grid</span><span><kbd>Shift + click</kbd> Multi-select</span><span><kbd>Ctrl Z/Y</kbd> Undo/redo</span><span><kbd>Ctrl C/V</kbd> Copy/paste</span><span><kbd>Ctrl D</kbd> Duplicate</span><span><kbd>Delete</kbd> Remove</span></div></Panel>
        </aside>
        <div
          className="sb-sidebar-resizer right"
          role="separator"
          aria-label="Resize right sidebar"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_LIMITS.right.min}
          aria-valuemax={SIDEBAR_LIMITS.right.max}
          aria-valuenow={sidebarWidths.right}
          tabIndex={0}
          onPointerDown={event => startSidebarResize('right', event)}
          onKeyDown={event => resizeSidebarByKeyboard('right', event)}
        />
      </div>
      {flowImportOpen && <FlowImportModal schema={draft} onClose={() => setFlowImportOpen(false)} onApply={plan => {
        changeDraft(previous => applyNodeRedImportPlan(previous, plan))
        setMockValues(previous => ({ ...previous, ...Object.fromEntries(plan.tags.map(tag => [tag.id, initialMockValue(tag)])) }))
        setFlowImportOpen(false)
        setNotice({ type: 'success', text: `Flow imported: ${plan.stats.tagsCreated} new tags and ${plan.stats.componentsCreated} new components. Reused items were not duplicated.` })
      }} />}
    </div>
  )
}

function FileMenu({ autoSave, onAutoSaveChange, dirty, revision, lastSavedAt, busy, onSave, onPreview, canImportFlow, onImportFlow, exportFlowDisabled, onExportFlow, canPublish, onPublish, runtimeHref }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePress = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePress)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePress)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const act = callback => {
    callback()
    setOpen(false)
  }

  return (
    <div className={`sb-view-menu sb-file-menu ${open ? 'is-open' : ''}`} ref={rootRef}>
      <HeaderMenuTrigger label="File" open={open} onToggle={setOpen} />
      {open && (
        <div className="sb-view-menu-popover" role="menu" aria-label="File actions">
          <div className="sb-file-menu-status" role="status">
            <span className={`sb-save-state ${dirty ? 'is-dirty' : ''}`}>
              {dirty ? `Unsaved · Revision ${revision}` : `Revision ${revision}`}
            </span>
            {lastSavedAt && <small>Last saved {lastSavedAt.toLocaleTimeString()}</small>}
          </div>
          <ViewMenuItem label="Autosave" value={autoSave ? 'On' : 'Off'} checked={autoSave} onClick={() => act(() => onAutoSaveChange(value => !value))} />
          <div className="sb-view-menu-divider" role="separator" />
          {canImportFlow && <ViewMenuItem label="Import flow JSON" disabled={busy} onClick={() => act(onImportFlow)} />}
          <ViewMenuItem label="Export flow JSON" disabled={busy || exportFlowDisabled} onClick={() => act(onExportFlow)} />
          <div className="sb-view-menu-divider" role="separator" />
          <ViewMenuItem label="Save" disabled={busy || !dirty} onClick={() => act(onSave)} />
          <ViewMenuItem label="Preview" onClick={() => act(onPreview)} />
          {canPublish && <ViewMenuItem label="Publish" disabled={busy} onClick={() => act(onPublish)} />}
          {runtimeHref && <ViewMenuItem label="Runtime" value="Open" onClick={() => act(() => globalThis.open(runtimeHref, '_blank', 'noopener,noreferrer'))} />}
        </div>
      )}
    </div>
  )
}

function EditMenu({ canUndo, canRedo, canDuplicate, onUndo, onRedo, onDuplicate }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePress = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePress)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePress)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const act = callback => {
    callback()
    setOpen(false)
  }

  return (
    <div className={`sb-view-menu sb-edit-menu ${open ? 'is-open' : ''}`} ref={rootRef}>
      <HeaderMenuTrigger label="Edit" open={open} onToggle={setOpen} />
      {open && (
        <div className="sb-view-menu-popover" role="menu" aria-label="Edit actions">
          <ViewMenuItem label="Undo" value="Ctrl+Z" disabled={!canUndo} onClick={() => act(onUndo)} />
          <ViewMenuItem label="Redo" value="Ctrl+Y" disabled={!canRedo} onClick={() => act(onRedo)} />
          <div className="sb-view-menu-divider" role="separator" />
          <ViewMenuItem label="Duplicate" value="Ctrl+D" disabled={!canDuplicate} onClick={() => act(onDuplicate)} />
        </div>
      )}
    </div>
  )
}

function ViewMenu({
  canvas,
  themeTone,
  onThemeToneChange,
  boardTone,
  onBoardToneChange,
  gridSize,
  onGridSizeChange,
  showGrid,
  onShowGridChange,
  snapToGrid,
  onSnapToGridChange,
  smartGuides,
  onSmartGuidesChange,
  showRulers,
  onShowRulersChange,
  zoom,
  onZoomChange,
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePress = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePress)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePress)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const act = callback => {
    callback()
    setOpen(false)
  }
  const zoomOut = () => onZoomChange(value => Math.max(.5, value - .1))
  const zoomIn = () => onZoomChange(value => Math.min(2, value + .1))

  return (
    <div className={`sb-view-menu ${open ? 'is-open' : ''}`} ref={rootRef}>
      <HeaderMenuTrigger label="View" open={open} onToggle={setOpen} />
      {open && (
        <div className="sb-view-menu-popover" role="menu" aria-label="Canvas view options">
          <div className="sb-view-menu-summary">
            <span>Canvas</span>
            <strong>{canvas.width} × {canvas.height}</strong>
          </div>
          <ViewMenuItem
            label="Theme tone"
            value={themeTone === 'cyan' ? 'Cyan' : 'Grey'}
            onClick={() => act(() => onThemeToneChange(themeTone === 'cyan' ? 'grey' : 'cyan'))}
          />
          <ViewMenuItem
            label="Board appearance"
            value={boardTone === 'dark' ? 'Dark' : 'Light'}
            onClick={() => act(() => onBoardToneChange(boardTone === 'dark' ? 'light' : 'dark'))}
          />
          <div className="sb-view-menu-step" role="none">
            <label htmlFor="sb-view-grid-step">Grid step</label>
            <span>
              <input
                id="sb-view-grid-step"
                type="number"
                min="4"
                max="200"
                value={gridSize}
                onChange={event => onGridSizeChange(Math.max(4, Math.min(200, Number(event.target.value) || 20)))}
              />
              px
            </span>
          </div>
          <div className="sb-view-menu-divider" role="separator" />
          <ViewMenuItem label="Show grid" checked={showGrid} onClick={() => act(() => onShowGridChange(value => !value))} />
          <ViewMenuItem label="Snap to grid" checked={snapToGrid} onClick={() => act(() => onSnapToGridChange(value => !value))} />
          <ViewMenuItem label="Smart guides" checked={smartGuides} onClick={() => act(() => onSmartGuidesChange(value => !value))} />
          <ViewMenuItem label="Show rulers" checked={showRulers} onClick={() => act(() => onShowRulersChange(value => !value))} />
          <div className="sb-view-menu-divider" role="separator" />
          <ViewMenuItem label="Zoom out" value="Ctrl+−" onClick={() => act(zoomOut)} />
          <ViewMenuItem label="Zoom in" value="Ctrl++" onClick={() => act(zoomIn)} />
          <ViewMenuItem label="Fit canvas" value="Ctrl+0" onClick={() => act(() => onZoomChange(1))} />
          <div className="sb-view-menu-zoom" aria-live="polite">Current zoom <strong>{Math.round(zoom * 100)}%</strong></div>
        </div>
      )}
    </div>
  )
}

function HeaderMenuTrigger({ label, open, onToggle }) {
  return (
    <button
      type="button"
      className="sb-view-menu-trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => onToggle(value => !value)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          onToggle(true)
        }
      }}
    >
      <span className="sb-menu-trigger-label">{label}</span>
      <i className="sb-menu-trigger-chevron" aria-hidden="true" />
    </button>
  )
}

function ViewMenuItem({ label, value = '', checked, disabled = false, onClick }) {
  const isToggle = typeof checked === 'boolean'
  const displayValue = value || (isToggle ? (checked ? 'On' : 'Off') : '')
  return (
    <button
      type="button"
      className="sb-view-menu-item"
      role={isToggle ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={isToggle ? checked : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      <small>{displayValue}</small>
    </button>
  )
}

function LoginScreen({ onAuthenticated, compact = false }) {
  const [email, setEmail] = useState('admin@scada.local'); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const submit = async event => { event.preventDefault(); setBusy(true); setError(''); try { await login(email, password); await onAuthenticated() } catch (requestError) { setError(requestError.message) } finally { setBusy(false) } }
  return <div className={compact ? 'sb-runtime-login' : 'sb-login-page'}><form className="sb-login-card" onSubmit={submit}><div className="sb-login-card-head"><div className="sb-login-mark">SC</div><ThemeToneToggle /></div><p className="eyebrow">SCADA SCHEMATIC PLATFORM</p><h1>{compact ? 'Runtime access' : 'Welcome to Scamatic Builder'}</h1><p>Private workspace access with revocable HttpOnly sessions.</p><label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} required /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} required autoFocus /></label>{error && <div className="sb-form-error">{error}</div>}<button type="submit" className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form></div>
}

function ProjectHome({ user, projects, busy, onOpen, onCreated, onProjectsChanged, onNotice, onLogout, notice }) {
  const [showCreate, setShowCreate] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [actionBusyId, setActionBusyId] = useState(null)
  const [pinRequest, setPinRequest] = useState(null)
  const canManage = user.capabilities?.includes('project.manage')
  const canDelete = user.capabilities?.includes('project.delete')
  const hiddenCount = projects.filter(project => project.hiddenAt).length
  const visibleProjects = showHidden ? projects : projects.filter(project => !project.hiddenAt)

  const runAction = async (project, action) => {
    let payload = { projectId: project.id, action }
    if (action === 'rename') {
      const name = window.prompt('New project name', project.name)
      if (name === null || name.trim() === project.name) return
      payload = { ...payload, name: name.trim() }
    }
    if (action === 'delete') {
      const confirmation = window.prompt(`Delete “${project.name}” permanently?\n\nType the project slug to confirm: ${project.slug}`)
      if (confirmation === null) return
      if (confirmation.trim() !== project.slug) return onNotice({ type: 'error', text: 'Delete cancelled: project slug did not match.' })
    }
    setActionBusyId(project.id)
    try {
      if (action === 'delete') {
        await apiRequest(`/api/projects?id=${encodeURIComponent(project.id)}`, { method: 'DELETE', body: JSON.stringify({ projectId: project.id, confirmSlug: project.slug }) })
        localStorage.removeItem(recoveryKey(project.id))
        onNotice({ type: 'success', text: `${project.name} was permanently deleted.` })
      } else {
        await apiRequest(`/api/projects?id=${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify(payload) })
        const message = action === 'rename'
          ? `Project renamed to ${payload.name}.`
          : action === 'hide'
            ? `${project.name} is now hidden.`
            : action === 'unhide'
              ? `${project.name} is visible again.`
              : `${project.name} is locked for this session.`
        onNotice({ type: 'success', text: message })
      }
      await onProjectsChanged()
    } catch (error) {
      onNotice({ type: 'error', text: error.message })
    } finally {
      setActionBusyId(null)
    }
  }

  const requestOpen = project => {
    if (project.security?.pinEnabled && !project.security?.unlocked) {
      setPinRequest({ project, intent: 'open' })
      return
    }
    onOpen(project)
  }

  const requestSecurity = project => {
    setPinRequest({ project, intent: project.security?.pinEnabled && !project.security?.unlocked ? 'manage-after-unlock' : 'setup' })
  }

  return (
    <div className="sb-home">
      <header className="sb-home-header"><div><span className="eyebrow">SCADA SCHEMATIC PLATFORM</span><h1>Scamatic<span>.Builder</span></h1></div><div className="sb-user-chip"><UserSettingsMenu user={user} onManageUsers={() => setShowMembers(true)} onChangePassword={() => setShowPassword(true)} onLogout={onLogout} /></div></header>
      <main>
        <div className="sb-home-lead">
          <div><h2>Projects</h2><p>Build schema-driven SCADA screens from sanitized SVG assets.</p></div>
          <div className="sb-home-actions">
            {canManage && hiddenCount > 0 && <button type="button" className={showHidden ? 'is-active' : ''} onClick={() => setShowHidden(value => !value)}>{showHidden ? 'Hide hidden projects' : `Show hidden (${hiddenCount})`}</button>}
            <button type="button" className="primary" onClick={() => setShowCreate(true)}>+ New project</button>
          </div>
        </div>
        {notice && <div className={`sb-notice ${notice.type}`}>{notice.text}</div>}
        <div className="sb-project-grid">
          {visibleProjects.map(project => <ProjectCard key={project.id} project={project} disabled={busy || actionBusyId === project.id} canManage={canManage} canDelete={canDelete} onOpen={requestOpen} onAction={runAction} onSecurity={requestSecurity} />)}
          {visibleProjects.length === 0 && <div className="sb-empty-projects">{projects.length === 0 ? 'No projects yet. Create the first builder project.' : 'No visible projects. Use “Show hidden” to restore one.'}</div>}
        </div>
      </main>
      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} onCreated={async project => { setShowCreate(false); await onCreated(project) }} />}
      {showMembers && <MemberAdminModal projects={projects} onClose={() => setShowMembers(false)} />}
      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} onChanged={() => { setShowPassword(false); onNotice({ type: 'success', text: 'Password changed successfully. Other signed-in devices have been logged out.' }) }} />}
      {pinRequest && <ProjectPinModal
        project={pinRequest.project}
        mode={pinRequest.intent === 'setup' ? 'setup' : 'unlock'}
        canRecover={canManage}
        onClose={() => setPinRequest(null)}
        onUnlocked={async () => {
          const unlockedProject = { ...pinRequest.project, security: { ...pinRequest.project.security, unlocked: true } }
          await onProjectsChanged()
          if (pinRequest.intent === 'open') {
            setPinRequest(null)
            await onOpen(unlockedProject)
          } else {
            setPinRequest({ project: unlockedProject, intent: 'setup' })
          }
        }}
        onRecovered={async () => {
          const unlockedProject = { ...pinRequest.project, security: { ...pinRequest.project.security, unlocked: true } }
          await onProjectsChanged()
          setPinRequest(null)
          if (pinRequest.intent === 'open') await onOpen(unlockedProject)
          else onNotice({ type: 'success', text: `${pinRequest.project.name} security PIN was reset.` })
        }}
        onChanged={async message => {
          setPinRequest(null)
          await onProjectsChanged()
          onNotice({ type: 'success', text: message })
        }}
      />}
    </div>
  )
}

function UserSettingsMenu({ user, onManageUsers, onChangePassword, onLogout }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = event => {
      if (event.type === 'keydown' && event.key !== 'Escape') return
      if (event.type === 'pointerdown' && rootRef.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [open])
  const act = action => { setOpen(false); action() }
  return (
    <div className="sb-settings-menu" ref={rootRef}>
      <button type="button" className="sb-settings-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><span className="sb-settings-gear" aria-hidden="true"></span>Settings<i aria-hidden="true" /></button>
      {open && <div className="sb-settings-popover" role="menu">
        <div className="sb-settings-identity"><span>{user.role}</span><div><strong>{user.displayName || 'SCADA user'}</strong><small>{user.email}</small></div></div>
        <div className="sb-settings-section"><small>Appearance</small><ThemeToneToggle /></div>
        <div className="sb-settings-divider" role="separator" />
        {user.capabilities?.includes('members.manage') && <button type="button" role="menuitem" onClick={() => act(onManageUsers)}>Manage users</button>}
        <button type="button" role="menuitem" onClick={() => act(onChangePassword)}>Change password</button>
        <button type="button" role="menuitem" className="danger" onClick={() => act(onLogout)}>Logout</button>
      </div>}
    </div>
  )
}

function ProjectCard({ project, disabled, canManage, canDelete, onOpen, onAction, onSecurity }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef(null)
  useEffect(() => {
    if (!menuOpen) return
    const close = event => {
      if (event.type === 'keydown' && event.key !== 'Escape') return
      if (event.type === 'pointerdown' && rootRef.current?.contains(event.target)) return
      setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [menuOpen])
  const act = action => { setMenuOpen(false); void onAction(project, action) }
  return (
    <article className={`sb-project-card ${project.hiddenAt ? 'is-hidden' : ''}`} ref={rootRef}>
      <button type="button" className="sb-project-card-open" onClick={() => onOpen(project)} disabled={disabled}>
        <span className="sb-project-icon">SC</span>
        <strong>{project.name}</strong>
        <code>/{project.slug}</code>
        <span>{project.canvas.width} × {project.canvas.height}</span>
        {project.security?.pinEnabled && <span className={`sb-project-pin-state ${project.security.unlocked ? 'is-unlocked' : 'is-locked'}`}><i aria-hidden="true">{project.security.unlocked ? '◇' : '◆'}</i>{project.security.unlocked ? 'PIN unlocked' : 'PIN locked'}</span>}
        <em>{project.hiddenAt ? 'Hidden' : project.activeVersionId ? 'Published' : 'Draft only'}</em>
      </button>
      {(canManage || canDelete) && <button type="button" className="sb-project-card-menu-trigger" aria-label={`Actions for ${project.name}`} aria-haspopup="menu" aria-expanded={menuOpen} disabled={disabled} onClick={() => setMenuOpen(value => !value)}>•••</button>}
      {menuOpen && <div className="sb-project-card-menu" role="menu">
        {canManage && <button type="button" role="menuitem" onClick={() => act('rename')}>Rename</button>}
        {canManage && <button type="button" role="menuitem" onClick={() => act(project.hiddenAt ? 'unhide' : 'hide')}>{project.hiddenAt ? 'Unhide' : 'Hide'}</button>}
        {canManage && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onSecurity(project) }}>{project.security?.pinEnabled ? 'Manage security PIN' : 'Set security PIN'}</button>}
        {project.security?.pinEnabled && project.security?.unlocked && <button type="button" role="menuitem" onClick={() => act('lock')}>Lock now</button>}
        {canDelete && <button type="button" role="menuitem" className="danger" onClick={() => act('delete')}>Delete</button>}
      </div>}
    </article>
  )
}

function ProjectPinModal({ project, mode, canRecover, onClose, onUnlocked, onRecovered, onChanged }) {
  const unlockMode = mode === 'unlock'
  const [recovering, setRecovering] = useState(false)
  const [form, setForm] = useState({ pin: '', confirmPin: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async event => {
    event.preventDefault()
    setError('')
    if (!/^\d{6}$/.test(form.pin)) return setError('Enter exactly 6 digits.')
    if ((!unlockMode || recovering) && form.pin !== form.confirmPin) return setError('PIN confirmation does not match.')
    setBusy(true)
    try {
      await apiRequest(`/api/projects?id=${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ projectId: project.id, action: recovering ? 'recover-pin' : unlockMode ? 'unlock' : 'set-pin', pin: form.pin, confirmPin: form.confirmPin, password: form.password }),
      })
      if (recovering) await onRecovered()
      else if (unlockMode) await onUnlocked()
      else await onChanged(project.security?.pinEnabled ? `${project.name} security PIN was changed.` : `${project.name} is now protected by a PIN.`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }
  const removePin = async () => {
    if (!window.confirm(`Remove PIN protection from “${project.name}”?`)) return
    setBusy(true); setError('')
    try {
      await apiRequest(`/api/projects?id=${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ projectId: project.id, action: 'remove-pin' }) })
      await onChanged(`${project.name} PIN protection was removed.`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="sb-modal-backdrop" onMouseDown={onClose}>
      <form className="sb-create-modal sb-project-pin-modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()} aria-labelledby="project-pin-title" autoComplete="off">
        <div className="sb-project-pin-heading"><span className="sb-project-pin-icon" aria-hidden="true">{unlockMode && !recovering ? '◆' : '◇'}</span><div><span className="eyebrow">PROJECT SECURITY</span><h2 id="project-pin-title">{recovering ? 'Reset security PIN' : unlockMode ? `Unlock ${project.name}` : project.security?.pinEnabled ? 'Change security PIN' : 'Set security PIN'}</h2><p>{recovering ? 'Confirm your account password, then choose a new project PIN. Existing unlock sessions will be revoked.' : unlockMode ? 'Enter the project PIN to continue. Unlock applies only to your current signed-in session.' : 'Use a non-sequential 6-digit PIN. The PIN is hashed and never returned after saving.'}</p></div></div>
        {recovering && <label>Account password<input type="password" autoComplete="current-password" value={form.password} onChange={event => setForm(previous => ({ ...previous, password: event.target.value }))} autoFocus required /></label>}
        <label>{unlockMode && !recovering ? 'Project PIN' : 'New project PIN'}<input type="password" inputMode="numeric" pattern="[0-9]{6}" minLength="6" maxLength="6" value={form.pin} onChange={event => setForm(previous => ({ ...previous, pin: event.target.value.replace(/\D/g, '').slice(0, 6) }))} autoFocus={!recovering} required /></label>
        {(!unlockMode || recovering) && <label>Confirm project PIN<input type="password" inputMode="numeric" pattern="[0-9]{6}" minLength="6" maxLength="6" value={form.confirmPin} onChange={event => setForm(previous => ({ ...previous, confirmPin: event.target.value.replace(/\D/g, '').slice(0, 6) }))} required /></label>}
        {unlockMode && canRecover && <button type="button" className="sb-project-pin-recovery" onClick={() => { setRecovering(value => !value); setForm({ pin: '', confirmPin: '', password: '' }); setError('') }} disabled={busy}>{recovering ? 'Use existing project PIN' : 'Forgot PIN? Reset with account password'}</button>}
        {error && <div className="sb-form-error" role="alert">{error}</div>}
        <div className="sb-modal-actions sb-project-pin-actions">
          {!unlockMode && project.security?.pinEnabled ? <button type="button" className="danger" onClick={removePin} disabled={busy}>Remove PIN</button> : <span />}
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Please wait…' : recovering ? 'Reset and unlock' : unlockMode ? 'Unlock project' : 'Save PIN'}</button>
        </div>
      </form>
    </div>
  )
}

const MEMBER_ROLE_META = {
  ADMIN: { label: 'Administrator', icon: 'A', summary: 'Full workspace administration, publishing, audit, and user management.', scope: 'Workspace-wide access' },
  EDITOR: { label: 'Editor', icon: 'E', summary: 'Builds and validates projects, configures sources, and accesses runtime.', scope: 'All workspace projects' },
  OPERATOR: { label: 'Operator', icon: 'O', summary: 'Views assigned runtimes and can execute permitted control commands.', scope: 'Assigned projects only' },
  VIEWER: { label: 'Viewer', icon: 'V', summary: 'Read-only access to the published runtimes explicitly assigned below.', scope: 'Assigned projects only' },
  OWNER: { label: 'Owner', icon: 'O', summary: 'Full authority over workspace security and configuration.', scope: 'Workspace-wide access' },
}

function MemberAdminModal({ projects, onClose }) {
  const [members, setMembers] = useState([])
  const [form, setForm] = useState({ email: '', displayName: '', password: '', role: 'VIEWER', projectIds: [] })
  const [error, setError] = useState(''); const [busy, setBusy] = useState(true)
  const load = useCallback(async () => { setBusy(true); try { const data = await apiRequest('/api/members'); setMembers(data.members || []) } catch (requestError) { setError(requestError.message) } finally { setBusy(false) } }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])
  const toggleProject = projectId => setForm(previous => ({ ...previous, projectIds: previous.projectIds.includes(projectId) ? previous.projectIds.filter(id => id !== projectId) : [...previous.projectIds, projectId] }))
  const submit = async event => { event.preventDefault(); setBusy(true); setError(''); try { await apiRequest('/api/members', { method: 'POST', body: JSON.stringify(form) }); setForm({ email: '', displayName: '', password: '', role: 'VIEWER', projectIds: [] }); await load() } catch (requestError) { setError(requestError.message); setBusy(false) } }
  const selectedRole = MEMBER_ROLE_META[form.role]
  const initials = member => (member.displayName || member.email || '?').split(/\s+|@/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase()
  return (
    <div className="sb-modal-backdrop" onMouseDown={onClose}>
      <div className="sb-member-modal" role="dialog" aria-modal="true" aria-labelledby="member-dialog-title" onMouseDown={event => event.stopPropagation()}>
        <header className="sb-member-header">
          <div className="sb-member-heading"><span className="sb-member-heading-icon" aria-hidden="true">RB</span><div><span className="eyebrow">ACCESS CONTROL</span><h2 id="member-dialog-title">Workspace members</h2><p>Provision identities and define their effective SCADA access.</p></div></div>
          <div className="sb-member-header-actions"><span className="sb-member-count"><strong>{members.length}</strong> {members.length === 1 ? 'member' : 'members'}</span><button type="button" className="sb-member-close" aria-label="Close member management" onClick={onClose}>×</button></div>
        </header>

        <section className="sb-member-directory" aria-labelledby="member-directory-title">
          <div className="sb-member-section-head"><div><h3 id="member-directory-title">Member directory</h3><p>Workspace role and account lifecycle status.</p></div><span>{members.filter(member => member.status === 'active').length} active</span></div>
          <div className="sb-member-list">
            {busy && members.length === 0 && <div className="sb-member-loading"><span className="sb-spinner" /> Loading members…</div>}
            {!busy && members.length === 0 && <div className="sb-member-empty">No workspace members found.</div>}
            {members.map(member => <article key={member.id} className="sb-member-row"><span className="sb-member-avatar" aria-hidden="true">{initials(member)}</span><span className="sb-member-identity"><strong>{member.displayName || member.email}</strong><small>{member.email}</small></span><span className={`sb-role-badge role-${member.role.toLowerCase()}`}>{MEMBER_ROLE_META[member.role]?.label || member.role}</span><span className={`sb-status-badge status-${member.status}`}>{member.status}</span></article>)}
          </div>
        </section>

        <form className="sb-member-form" onSubmit={submit} autoComplete="off">
          <div className="sb-member-section-head"><div><span className="eyebrow">PROVISION ACCOUNT</span><h3>Add a workspace member</h3><p>Create credentials, choose a role, then constrain runtime scope when required.</p></div><span className="sb-step-chip">NEW IDENTITY</span></div>
          <div className="sb-member-form-layout">
            <div className="sb-member-fields">
              <label>Display name<span className="sb-field-help">Operator-facing identity</span><input autoComplete="off" placeholder="e.g. Shift Supervisor" value={form.displayName} onChange={event => setForm(previous => ({ ...previous, displayName: event.target.value }))} required /></label>
              <label>Email address<span className="sb-field-help">Used for secure sign-in</span><input type="email" autoComplete="off" placeholder="name@company.com" value={form.email} onChange={event => setForm(previous => ({ ...previous, email: event.target.value }))} required /></label>
              <label>Temporary password<span className="sb-field-help">Minimum 10 characters</span><input type="password" autoComplete="new-password" minLength="10" placeholder="Enter a temporary password" value={form.password} onChange={event => setForm(previous => ({ ...previous, password: event.target.value }))} required /></label>
              <label>Workspace role<span className="sb-field-help">Defines capabilities and project scope</span><select value={form.role} onChange={event => setForm(previous => ({ ...previous, role: event.target.value, projectIds: [] }))}><option>ADMIN</option><option>EDITOR</option><option>OPERATOR</option><option>VIEWER</option></select></label>
              <div className="sb-role-summary"><span className={`sb-role-symbol role-${form.role.toLowerCase()}`}>{selectedRole.icon}</span><div><strong>{selectedRole.label}</strong><p>{selectedRole.summary}</p><small>{selectedRole.scope}</small></div></div>
            </div>

            <div className="sb-member-scope">
              <div className="sb-scope-head"><div><span className="eyebrow">PROJECT SCOPE</span><h4>{['OPERATOR', 'VIEWER'].includes(form.role) ? 'Assigned projects' : 'Workspace coverage'}</h4></div>{['OPERATOR', 'VIEWER'].includes(form.role) && <span>{form.projectIds.length}/{projects.length}</span>}</div>
              {['OPERATOR', 'VIEWER'].includes(form.role) ? <div className="sb-project-assignment-list">{projects.map(project => <label className={`sb-project-assignment ${form.projectIds.includes(project.id) ? 'is-selected' : ''}`} key={project.id}><input type="checkbox" checked={form.projectIds.includes(project.id)} onChange={() => toggleProject(project.id)} /><span className="sb-project-assignment-icon">SC</span><span><strong>{project.name}</strong><small>/{project.slug}</small></span><i>{form.projectIds.includes(project.id) ? '✓' : '+'}</i></label>)}{projects.length === 0 && <p className="sb-member-empty">Create a project before assigning runtime access.</p>}</div> : <div className="sb-global-scope"><span aria-hidden="true">◇</span><strong>No project selection required</strong><p>{selectedRole.label} receives access to every project in this workspace according to its capability set.</p></div>}
            </div>
          </div>
          {error && <div className="sb-form-error" role="alert">{error}</div>}
          <footer className="sb-member-form-footer"><p>Creating a member writes an RBAC audit event. Credentials are never returned after submission.</p><button type="submit" className="primary" disabled={busy}><span aria-hidden="true">＋</span>{busy ? 'Provisioning…' : 'Create member'}</button></footer>
        </form>
      </div>
    </div>
  )
}

function CreateProjectModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: 'WTP Mixer', slug: 'wtp-mixer', description: '', width: 1920, height: 1080 }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const submit = async event => { event.preventDefault(); setBusy(true); setError(''); try { const data = await apiRequest('/api/projects', { method: 'POST', body: JSON.stringify(form) }); await onCreated(data.project) } catch (requestError) { setError(requestError.message) } finally { setBusy(false) } }
  const set = (key, value) => setForm(previous => ({ ...previous, [key]: value }))
  return <div className="sb-modal-backdrop" onMouseDown={onClose}><form className="sb-create-modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()}><div><span className="eyebrow">NEW PROJECT</span><h2>Create SCADA project</h2></div><label>Name<input value={form.name} onChange={event => { set('name', event.target.value); set('slug', slugify(event.target.value)) }} /></label><label>Slug<input value={form.slug} onChange={event => set('slug', event.target.value)} /></label><label>Description<textarea value={form.description} onChange={event => set('description', event.target.value)} /></label><div className="sb-form-grid"><label>Canvas width<input type="number" value={form.width} onChange={event => set('width', Number(event.target.value))} /></label><label>Canvas height<input type="number" value={form.height} onChange={event => set('height', Number(event.target.value))} /></label></div>{error && <div className="sb-form-error">{error}</div>}<div className="sb-modal-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button></div></form></div>
}

function ChangePasswordModal({ onClose, onChanged }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [encoderOpen, setEncoderOpen] = useState(false)
  const [encoderSource, setEncoderSource] = useState('')
  const [encodedPassword, setEncodedPassword] = useState('')
  const set = (key, value) => setForm(previous => ({ ...previous, [key]: value }))
  const submit = async event => {
    event.preventDefault()
    setError('')
    if (form.newPassword.length < 10) return setError('New password must contain at least 10 characters.')
    if (form.newPassword === form.currentPassword) return setError('New password must be different from the current password.')
    if (form.newPassword !== form.confirmPassword) return setError('New password confirmation does not match.')
    setBusy(true)
    try {
      await apiRequest('/api/auth', { method: 'PATCH', body: JSON.stringify(form) })
      onChanged()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }
  const generateEncodedPassword = () => {
    setError('')
    try {
      const encoded = encodeHardPassword(encoderSource)
      if (encoded.length < 10) return setError('Encoded password must contain at least 10 characters. Add more source characters.')
      if (encoded.length > 256) return setError('Encoded password exceeds the 256-character limit. Shorten the source.')
      setEncodedPassword(encoded)
    } catch (encoderError) {
      setEncodedPassword('')
      setError(encoderError.message)
    }
  }
  const useEncodedPassword = () => {
    setForm(previous => ({ ...previous, newPassword: encodedPassword, confirmPassword: encodedPassword }))
    setError('')
  }
  return (
    <div className="sb-modal-backdrop" onMouseDown={onClose}>
      <form className="sb-create-modal sb-password-modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()} aria-labelledby="change-password-title">
        <div><span className="eyebrow">ACCOUNT SECURITY</span><h2 id="change-password-title">Change password</h2><p>Use at least 10 characters. Your current session stays active and all other sessions will be revoked.</p></div>
        <label>Current password<input type="password" autoComplete="current-password" value={form.currentPassword} onChange={event => set('currentPassword', event.target.value)} maxLength="256" required autoFocus /></label>
        <label>New password<input type="password" autoComplete="new-password" value={form.newPassword} onChange={event => set('newPassword', event.target.value)} minLength="10" maxLength="256" required /></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" value={form.confirmPassword} onChange={event => set('confirmPassword', event.target.value)} minLength="10" maxLength="256" required /></label>
        <section className="sb-password-encoder">
          <button type="button" className="sb-password-encoder-toggle" aria-expanded={encoderOpen} onClick={() => setEncoderOpen(value => !value)}><span>Hard password encoder <small>Optional</small></span><i aria-hidden="true">{encoderOpen ? '−' : '+'}</i></button>
          {encoderOpen && <div className="sb-password-encoder-body">
            <p>This deterministic pattern is a convenience encoder, not encryption. The selected result is still securely hashed before storage.</p>
            <label>Letters and numbers only<input value={encoderSource} onChange={event => { setEncoderSource(event.target.value); setEncodedPassword('') }} maxLength="128" pattern="[A-Za-z0-9]+" spellCheck="false" /></label>
            <button type="button" onClick={generateEncodedPassword}>Generate encoded password</button>
            {encodedPassword && <div className="sb-password-encoder-result"><span>Generated result</span><code>{encodedPassword}</code><button type="button" className="primary" onClick={useEncodedPassword}>Use this password</button></div>}
          </div>}
        </section>
        {error && <div className="sb-form-error" role="alert">{error}</div>}
        <div className="sb-modal-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button></div>
      </form>
    </div>
  )
}

function SvgUploader({ projectId, beforeUpload, onUploaded, onError }) {
  const [busy, setBusy] = useState(false)
  const upload = async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (!file.name.toLowerCase().endsWith('.svg') || file.size > 5 * 1024 * 1024) return onError('Choose an SVG file smaller than 5 MB.'); setBusy(true); try { const ready = await beforeUpload?.(); if (!ready) throw new Error('Save the current draft before replacing the SVG.'); const data = await apiRequest('/api/svg', { method: 'POST', body: JSON.stringify({ projectId, svg: await file.text() }) }); onUploaded(data) } catch (error) { onError(error.message) } finally { setBusy(false) } }
  return <label className="sb-upload-button">{busy ? 'Sanitizing…' : 'Upload / replace base SVG'}<input type="file" accept=".svg,image/svg+xml" onChange={upload} disabled={busy} /></label>
}

function DesignElementUploader({ projectId, onUploaded, onError }) {
  const [busy, setBusy] = useState(false)
  const upload = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      onUploaded(await uploadDesignElementFile(projectId, file))
    } catch (error) {
      onError(error.message)
    } finally {
      setBusy(false)
    }
  }
  return <label className="sb-add-element-button">{busy ? 'Uploading element…' : '+ Add Element'}<input type="file" accept=".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml" onChange={upload} disabled={busy} /></label>
}

async function uploadDesignElementFile(projectId, file) {
  if (!/\.(png|jpe?g|svg)$/i.test(file.name) || file.size > 3 * 1024 * 1024) throw new Error('Choose a PNG, JPG, JPEG, or SVG file smaller than 3 MB.')
  const content = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name) ? await file.text() : await fileAsBase64(file)
  const data = await apiRequest('/api/elements', { method: 'POST', body: JSON.stringify({ projectId, fileName: file.name, mimeType: file.type || mimeTypeFromName(file.name), content }) })
  return data.asset
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Unable to read the selected image.'))
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
    reader.readAsDataURL(file)
  })
}

function mimeTypeFromName(name) {
  if (/\.png$/i.test(name)) return 'image/png'
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg'
  if (/\.svg$/i.test(name)) return 'image/svg+xml'
  return ''
}

function MultiSelectionActions({ count, onArrange, onDuplicate, onDelete, onLock, onHide }) {
  const controls = [
    ['left', '⇤', 'Align left'], ['center-x', '↔', 'Align horizontal center'], ['right', '⇥', 'Align right'],
    ['top', '↥', 'Align top'], ['center-y', '↕', 'Align vertical center'], ['bottom', '↧', 'Align bottom'],
    ['distribute-x', '⋯', 'Distribute horizontally'], ['distribute-y', '⋮', 'Distribute vertically'],
  ]
  return <div className="sb-multi-actions"><p>{count} components selected. Drag one selected component to move the whole group.</p><div className="sb-arrange-grid">{controls.map(([action, icon, label]) => <button key={action} type="button" title={label} aria-label={label} disabled={action.startsWith('distribute') && count < 3} onClick={() => onArrange(action)}>{icon}</button>)}</div><button type="button" onClick={onDuplicate}>Duplicate selection</button><button type="button" onClick={onLock}>Lock selection</button><button type="button" onClick={onHide}>Hide selection</button><button type="button" className="danger" onClick={onDelete}>Delete selection</button></div>
}
function VersionList({ versions, activeVersionId, canRestore, onRestore }) {
  const nextVersion = nextVersionNumber(versions)
  return <div className="sb-version-list"><p className="sb-version-help">Published history is immutable. Restoring creates the next numbered snapshot and preserves its source.</p>{versions.map(version => {
    const description = describeVersion(version, versions)
    const active = version.id === activeVersionId
    return <div key={version.id} className={`${active ? 'is-active' : ''} ${description.kind === 'restore' ? 'is-restore' : ''}`}><div className="sb-version-info"><div className="sb-version-heading"><strong>v{version.version}</strong>{description.kind === 'restore' && <b>RESTORED</b>}</div><small><strong>{description.label}</strong><time>{version.createdAt ? new Date(version.createdAt).toLocaleString() : 'Legacy snapshot'}</time></small></div>{active ? <em>ACTIVE</em> : canRestore && <button type="button" title={`Create v${nextVersion} from v${version.version} and make it active`} onClick={() => onRestore(version)}>Restore → v{nextVersion}</button>}</div>
  })}{versions.length === 0 && <p className="sb-muted">No published versions.</p>}</div>
}
function AuditList({ events }) {
  return <div className="sb-audit-list">{events.map(event => <article className="sb-audit-card" key={event.id}><header><b>{auditActionCategory(event.action)}</b><span>{String(event.targetType || 'event').toUpperCase()}</span></header><strong title={event.action}>{auditActionLabel(event.action)}</strong><code>{event.action}</code><footer><span title={event.actorId}>Actor · {event.actorId}</span><time>{event.timestamp ? new Date(event.timestamp).toLocaleString() : 'Unknown time'}</time></footer></article>)}{events.length === 0 && <p className="sb-muted">No audit events.</p>}</div>
}
function batchPatch(ids, patch, changeDraft) { const selected = new Set(ids); changeDraft(previous => ({ ...previous, components: previous.components.map(component => selected.has(component.id) ? { ...component, ...patch } : component) })) }
function Panel({ title, description, children, collapsible = false, defaultOpen = true, storageKey }) {
  const [open, setOpen] = useState(() => {
    if (!collapsible) return true
    try {
      const stored = storageKey && globalThis.localStorage?.getItem(storageKey)
      return stored === null || stored === undefined ? defaultOpen : stored === 'open'
    } catch {
      return defaultOpen
    }
  })

  useEffect(() => {
    if (!collapsible || !storageKey) return
    try { globalThis.localStorage?.setItem(storageKey, open ? 'open' : 'closed') } catch { /* Storage can be unavailable in private contexts. */ }
  }, [collapsible, open, storageKey])

  if (!collapsible) return <section className="sb-panel"><h3>{title}</h3>{children}</section>
  return <section className={`sb-panel sb-collapsible-panel ${open ? 'is-open' : 'is-closed'}`}><button type="button" className="sb-panel-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><span><strong>{title}</strong>{description && <small>{description}</small>}</span><i aria-hidden="true" /></button><div className="sb-panel-body" hidden={!open}>{children}</div></section>
}
function CenteredState({ title }) { return <div className="sb-centered-state"><span className="sb-spinner" /><p>{title}</p></div> }
function slugify(value) { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) }
