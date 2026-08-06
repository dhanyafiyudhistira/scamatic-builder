import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { commandUiState, evaluateRule, formatRuntimeValue, tuningInteractionState, valueSeverity } from '../../shared/runtime-evaluator.js'
import { commandResultRetentionMs, isPendingCommandStatus } from '../../shared/command-lifecycle.js'
import { offsetBounds, resizeComponentBounds, resolveSmartSnap, selectionBounds } from '../../shared/placement.js'
import { TelemetryChart } from './TelemetryChart.jsx'
import { rootRuntimeComponents } from '../../shared/control-popup.js'

export function RuntimeCanvas({
  schema,
  svg,
  designAssets = {},
  values = {},
  qualities = {},
  histories = {},
  historyStorage = null,
  selectedIds = [],
  editable = false,
  boardTone,
  zoom = 1,
  actorRole = 'VIEWER',
  gridSize = 20,
  snapToGrid = true,
  showGrid = true,
  showRulers = true,
  smartGuides = true,
  onSelect,
  onChange,
  onTransformStart,
  onTransformEnd,
  onDesignFileDrop,
  onCommand,
  commandResults = {},
  commandConnectionAvailable = true,
}) {
  const canvasRef = useRef(null)
  const [guides, setGuides] = useState({ x: null, y: null })
  const [coordinate, setCoordinate] = useState(null)
  const [transformHud, setTransformHud] = useState(null)
  const [expandedChartId, setExpandedChartId] = useState(null)
  const [openPopupId, setOpenPopupId] = useState(null)
  const [fileDragOver, setFileDragOver] = useState(false)
  const [operationModes, setOperationModes] = useState({})
  const popupReturnFocusRef = useRef(null)
  const commandHandlerRef = useRef(onCommand)
  commandHandlerRef.current = onCommand
  const canvas = schema?.project?.canvas || { width: 1920, height: 1080, background: '#101418' }
  const tags = useMemo(() => new Map((schema?.tags || []).map(tag => [tag.id, tag])), [schema?.tags])
  const components = schema?.components || []
  const componentById = useMemo(() => new Map(components.map(component => [component.id, component])), [components])
  const rootComponents = useMemo(() => rootRuntimeComponents(components), [components])
  const expandedChart = (schema?.components || []).find(component => component.id === expandedChartId && component.type === 'chart' && component.visible !== false)
  const openPopup = componentById.get(openPopupId)
  const operationShifters = useMemo(() => components.filter(component => component.type === 'operation-shifter'), [components])
  const invokeCommand = useCallback((...args) => commandHandlerRef.current?.(...args), [])
  const stableCommandHandler = onCommand ? invokeCommand : undefined
  const expandChart = useCallback(componentId => setExpandedChartId(componentId), [])
  const changeOperationMode = useCallback((componentId, mode) => {
    setOperationModes(previous => ({ ...previous, [componentId]: mode }))
  }, [])

  useEffect(() => {
    setOperationModes(previous => {
      const next = { ...previous }
      let changed = false
      for (const shifter of operationShifters) {
        const observedTagId = shifter.properties?.feedbackTagId || shifter.binding?.tagId
        const observed = String(values[observedTagId] || '').toLowerCase()
        const resolved = ['manual', 'auto', 'reset'].includes(observed) ? observed : next[shifter.id] || 'manual'
        if (next[shifter.id] !== resolved) { next[shifter.id] = resolved; changed = true }
      }
      return changed ? next : previous
    })
  }, [operationShifters, values])

  const operationLockFor = componentId => {
    const owner = operationShifters.find(shifter => (shifter.properties?.controlledComponentIds || []).includes(componentId))
    const mode = owner ? operationModes[owner.id] || 'manual' : 'manual'
    return owner && mode !== 'manual' ? `${mode.toUpperCase()} LOCK` : ''
  }

  useEffect(() => {
    if (editable || (expandedChartId && !expandedChart)) setExpandedChartId(null)
  }, [editable, expandedChart, expandedChartId])

  useEffect(() => {
    if (editable || (openPopupId && openPopup?.type !== 'control-popup')) setOpenPopupId(null)
  }, [editable, openPopup, openPopupId])

  useEffect(() => {
    if (!expandedChartId) return
    const closeOnEscape = event => {
      if (event.key === 'Escape') setExpandedChartId(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [expandedChartId])

  const startTransform = (event, component, mode) => {
    if (!editable || component.locked || !canvasRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const resizing = mode.startsWith('resize-')
    const additive = !resizing && (event.shiftKey || event.ctrlKey || event.metaKey)
    const preserveGroup = mode === 'move' && !additive && selectedIds.length > 1 && selectedIds.includes(component.id)
    if (!preserveGroup) onSelect?.(component.id, { additive })
    onTransformStart?.()
    const rect = canvasRef.current.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const components = schema?.components || []
    const groupIds = !resizing && mode === 'move' && selectedIds.includes(component.id) && selectedIds.length > 1
      ? new Set(selectedIds)
      : new Set([component.id])
    const originals = components
      .filter(item => groupIds.has(item.id) && !item.locked)
      .map(item => ({ id: item.id, position: { ...item.position } }))
    const groupBounds = selectionBounds(originals.map(item => ({ position: item.position })))
    const targetBounds = components
      .filter(item => !groupIds.has(item.id) && item.visible !== false)
      .map(item => item.position)
    targetBounds.push({ x: 0, y: 0, width: canvas.width, height: canvas.height })

    const move = pointer => {
      const rawDx = (pointer.clientX - startX) * (canvas.width / rect.width)
      const rawDy = (pointer.clientY - startY) * (canvas.height / rect.height)
      const snap = value => snapToGrid ? snapValue(value, gridSize) : value
      setCoordinate(pointerToLogical(pointer, rect, canvas))

      if (resizing) {
        const original = originals[0].position
        const configuredAspectLock = component.type === 'design-image' && component.properties?.lockAspectRatio !== false
        const next = resizeComponentBounds(original, mode.slice('resize-'.length), rawDx, rawDy, canvas, {
          minSize: 24,
          gridSize,
          snapToGrid,
          lockAspect: pointer.shiftKey ? !configuredAspectLock : configuredAspectLock,
        })
        setTransformHud({ ...next, mode: 'resize' })
        onChange?.(component.id, { position: next }, { transient: true })
        return
      }

      let dx = snap(groupBounds.x + rawDx) - groupBounds.x
      let dy = snap(groupBounds.y + rawDy) - groupBounds.y
      let nextBounds = offsetBounds(groupBounds, dx, dy)
      if (smartGuides) {
        const tolerance = Math.max(2, 6 * canvas.width / rect.width)
        const matched = resolveSmartSnap(nextBounds, targetBounds, tolerance)
        dx += matched.dx
        dy += matched.dy
        setGuides({ x: matched.xGuide, y: matched.yGuide })
      }
      dx = Math.max(-groupBounds.x, Math.min(canvas.width - groupBounds.x - groupBounds.width, dx))
      dy = Math.max(-groupBounds.y, Math.min(canvas.height - groupBounds.y - groupBounds.height, dy))
      nextBounds = offsetBounds(groupBounds, dx, dy)
      setTransformHud({ ...nextBounds, mode: originals.length > 1 ? 'group' : 'move' })
      for (const original of originals) {
        onChange?.(original.id, { position: { ...original.position, x: clean(original.position.x + dx), y: clean(original.position.y + dy) } }, { transient: true })
      }
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      setGuides({ x: null, y: null })
      setTransformHud(null)
      onTransformEnd?.()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const launchPopup = useCallback((componentId, trigger) => {
    popupReturnFocusRef.current = trigger || null
    setOpenPopupId(componentId)
  }, [])

  const closePopup = () => {
    setOpenPopupId(null)
    window.requestAnimationFrame(() => popupReturnFocusRef.current?.focus())
  }

  return (
    <div className="sb-canvas-shell">
      <div
        ref={canvasRef}
        className={`sb-logical-canvas ${editable ? 'is-editable' : ''} ${editable && showGrid ? 'show-grid' : ''} ${fileDragOver ? 'is-file-dragover' : ''} ${boardTone ? `board-tone-${boardTone}` : ''}`}
        style={{
          aspectRatio: `${canvas.width}/${canvas.height}`,
          background: boardTone ? (boardTone === 'light' ? '#f2f3ef' : '#101418') : canvas.background,
          '--grid-x': `${Math.max(4, gridSize) / canvas.width * 100}%`,
          '--grid-y': `${Math.max(4, gridSize) / canvas.height * 100}%`,
          '--major-grid-x': `${Math.max(4, gridSize) * 5 / canvas.width * 100}%`,
          '--major-grid-y': `${Math.max(4, gridSize) * 5 / canvas.height * 100}%`,
          width: `${Math.max(.35, Math.min(2.5, zoom)) * 100}%`,
          maxWidth: zoom > 1 ? 'none' : '1500px',
          maxHeight: zoom > 1 ? 'none' : '100%',
        }}
        onPointerDown={event => { if (event.target === event.currentTarget) onSelect?.(null, { additive: false }) }}
        onPointerMove={event => editable && setCoordinate(pointerToLogical(event, event.currentTarget.getBoundingClientRect(), canvas))}
        onPointerLeave={() => !transformHud && setCoordinate(null)}
        onDragOver={event => {
          if (!editable || !onDesignFileDrop || !Array.from(event.dataTransfer?.types || []).includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setFileDragOver(true)
        }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFileDragOver(false) }}
        onDrop={event => {
          if (!editable || !onDesignFileDrop) return
          event.preventDefault()
          setFileDragOver(false)
          const file = event.dataTransfer?.files?.[0]
          if (file) onDesignFileDrop(file, pointerToLogical(event, event.currentTarget.getBoundingClientRect(), canvas))
        }}
      >
        {svg
          ? <div className="sb-svg-background" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
          : <div className="sb-empty-canvas">Upload an SVG schematic to begin</div>}
        {editable && fileDragOver && <div className="sb-canvas-file-drop" aria-hidden="true"><strong>DROP IMAGE HERE</strong><span>PNG, JPG, or SVG · positioned at your cursor</span></div>}

        {rootComponents.map(component => {
          if (component.visible === false) return null
          const value = values[component.binding?.tagId]
          const quality = qualities[component.binding?.tagId] || 'good'
          const selected = selectedIds.includes(component.id)
          return <RuntimeOverlay
            key={component.id}
            component={component}
            designAsset={designAssets[component.properties?.assetId]}
            canvas={canvas}
            tags={tags}
            value={value}
            quality={quality}
            selected={selected}
            selectedCount={selectedIds.length}
            editable={editable}
            actorRole={actorRole}
            onCommand={stableCommandHandler}
            commandResult={commandResults[component.id]}
            onExpandChart={expandChart}
            onOpenPopup={launchPopup}
            commandConnectionAvailable={commandConnectionAvailable}
            operationMode={operationModes[component.id] || 'manual'}
            onOperationModeChange={changeOperationMode}
            operationLockLabel={operationLockFor(component.id)}
            componentById={componentById}
            onStartTransform={editable ? startTransform : null}
            onSelect={onSelect}
          />
        })}
        {editable && showRulers && <CanvasRulers canvas={canvas} gridSize={gridSize} />}
        {editable && guides.x !== null && <span className="sb-smart-guide vertical" style={{ left: `${guides.x / canvas.width * 100}%` }} />}
        {editable && guides.y !== null && <span className="sb-smart-guide horizontal" style={{ top: `${guides.y / canvas.height * 100}%` }} />}
        {editable && transformHud && <CoordinateHud data={transformHud} />}
        {editable && coordinate && !transformHud && <div className="sb-cursor-coordinate">X {formatCoordinate(coordinate.x)} · Y {formatCoordinate(coordinate.y)}</div>}
        {!editable && expandedChart && (
          <ExpandedChart
            component={expandedChart}
            tags={(expandedChart.binding?.tagIds || []).map(tagId => tags.get(tagId)).filter(Boolean)}
            histories={withCurrentChartSamples(expandedChart, histories, values, qualities)}
            historyStorage={historyStorage}
            onClose={() => setExpandedChartId(null)}
          />
        )}
        {!editable && openPopup?.type === 'control-popup' && (
          <ControlPopupDialog
            component={openPopup}
            childComponents={(Array.isArray(openPopup.children) ? openPopup.children : []).map(childId => componentById.get(childId)).filter(child => child && child.visible !== false)}
            tags={tags}
            values={values}
            qualities={qualities}
            actorRole={actorRole}
            onCommand={stableCommandHandler}
            commandResults={commandResults}
            commandConnectionAvailable={commandConnectionAvailable}
            operationModes={operationModes}
            onOperationModeChange={changeOperationMode}
            operationLockFor={operationLockFor}
            componentById={componentById}
            onClose={closePopup}
          />
        )}
      </div>
    </div>
  )
}

const RuntimeOverlay = memo(function RuntimeOverlay({
  component,
  designAsset,
  canvas,
  tags,
  value,
  quality,
  selected,
  selectedCount,
  editable,
  actorRole,
  onCommand,
  commandResult,
  onExpandChart,
  onOpenPopup,
  commandConnectionAvailable,
  operationMode,
  onOperationModeChange,
  operationLockLabel,
  componentById,
  onStartTransform,
  onSelect,
}) {
  const position = component.position
  const tag = tags.get(component.binding?.tagId)
  const chartTags = useMemo(
    () => (component.binding?.tagIds || []).map(tagId => tags.get(tagId)).filter(Boolean),
    [component.binding?.tagIds, tags],
  )

  return (
    <div
      className={`sb-overlay ${selected ? 'is-selected' : ''} ${component.locked ? 'is-locked' : ''}`}
      style={{
        left: `${position.x / canvas.width * 100}%`,
        top: `${position.y / canvas.height * 100}%`,
        width: `${position.width / canvas.width * 100}%`,
        height: `${position.height / canvas.height * 100}%`,
        transform: `rotate(${position.rotation || 0}deg)`,
        zIndex: component.zIndex || 1,
      }}
      onPointerDown={onStartTransform ? event => onStartTransform(event, component, 'move') : undefined}
      onClick={editable ? event => {
        event.stopPropagation()
        if (selected && selectedCount > 1) return
        onSelect?.(component.id, { additive: event.shiftKey || event.ctrlKey || event.metaKey })
      } : undefined}
    >
      <RuntimeComponentBoundary componentName={component.name}>
        <RuntimeComponent
          component={component}
          designAsset={designAsset}
          tag={tag}
          value={value}
          quality={quality}
          chartTags={chartTags}
          editable={editable}
          actorRole={actorRole}
          onCommand={onCommand}
          commandResult={commandResult}
          onExpandChart={() => onExpandChart(component.id)}
          onOpenPopup={trigger => onOpenPopup(component.id, trigger)}
          commandConnectionAvailable={commandConnectionAvailable}
          operationMode={operationMode}
          onOperationModeChange={mode => onOperationModeChange(component.id, mode)}
          operationLockLabel={operationLockLabel}
          componentById={componentById}
        />
      </RuntimeComponentBoundary>
      {editable && selected && !component.locked && RESIZE_HANDLES.map(handle => <button
        type="button"
        className={`sb-resize-handle handle-${handle}`}
        aria-label={`Resize ${component.name} from ${handle}`}
        title={component.type === 'design-image' && handle.length === 2 ? 'Drag to resize · Hold Shift to toggle aspect ratio lock' : 'Drag to resize'}
        key={handle}
        onPointerDown={event => onStartTransform?.(event, component, `resize-${handle}`)}
      />)}
      {editable && component.locked && <span className="sb-lock-badge" title="Component locked">▣</span>}
    </div>
  )
})

const RESIZE_HANDLES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'])

function CanvasRulers({ canvas, gridSize }) {
  const xStep = rulerStep(canvas.width, gridSize, 12)
  const yStep = rulerStep(canvas.height, gridSize, 8)
  const xTicks = makeTicks(canvas.width, xStep)
  const yTicks = makeTicks(canvas.height, yStep)
  return (
    <div className="sb-canvas-rulers" aria-hidden="true">
      <div className="sb-ruler-corner">0</div>
      <div className="sb-ruler top">{xTicks.slice(1).map(value => <span key={value} style={{ left: `${value / canvas.width * 100}%` }}>{value}</span>)}</div>
      <div className="sb-ruler left">{yTicks.slice(1).map(value => <span key={value} style={{ top: `${value / canvas.height * 100}%` }}>{value}</span>)}</div>
    </div>
  )
}

function CoordinateHud({ data }) {
  return (
    <div className="sb-coordinate-hud">
      <strong>{data.mode === 'group' ? 'GROUP' : data.mode.toUpperCase()}</strong>
      <span>X {formatCoordinate(data.x)}</span><span>Y {formatCoordinate(data.y)}</span>
      <span>W {formatCoordinate(data.width)}</span><span>H {formatCoordinate(data.height)}</span>
    </div>
  )
}

function pointerToLogical(pointer, rect, canvas) {
  return {
    x: Math.max(0, Math.min(canvas.width, (pointer.clientX - rect.left) * canvas.width / rect.width)),
    y: Math.max(0, Math.min(canvas.height, (pointer.clientY - rect.top) * canvas.height / rect.height)),
  }
}

function rulerStep(length, gridSize, divisions) {
  const grid = Math.max(1, Number(gridSize) || 20)
  return Math.max(grid * 5, Math.ceil(length / divisions / grid) * grid)
}

function makeTicks(length, step) {
  return Array.from({ length: Math.floor(length / step) + 1 }, (_, index) => index * step)
}

function formatCoordinate(value) {
  return Number.isInteger(value) ? value : value.toFixed(1)
}

function clean(value) {
  return Math.abs(value - Math.round(value)) < .0001 ? Math.round(value) : Number(value.toFixed(3))
}

class RuntimeComponentBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) { console.error('Runtime component failed:', this.props.componentName, error) }
  render() { return this.state.failed ? <div className="sb-runtime-component-error" role="status"><strong>COMPONENT ERROR</strong><span>{this.props.componentName}</span></div> : this.props.children }
}

function RuntimeComponent({ component, designAsset, tag, value, quality, chartTags, editable, actorRole, onCommand, commandResult, onExpandChart, onOpenPopup, commandConnectionAvailable, operationMode = 'manual', onOperationModeChange, operationLockLabel = '', componentById }) {
  const [commandState, setCommandState] = useState('idle')
  const properties = component.properties || {}
  const qualityLabel = quality !== 'good' ? quality.toUpperCase() : null
  const visibleCommandState = commandResult?.status || commandState

  if (component.type === 'indicator-lamp') {
    const active = evaluateRule(value, properties.rule)
    const color = active ? (properties.onColor || '#22c55e') : (properties.offColor || '#64748b')
    return (
      <div className={`sb-lamp-component quality-${quality}`} title={`${tag?.name || 'Unbound'}: ${String(value ?? '--')} · ${quality}`}>
        <span
          className={`sb-runtime-lamp ${active && properties.glow !== false ? 'has-glow' : ''}`}
          style={{ '--lamp-color': color, borderRadius: properties.shape === 'square' ? '20%' : properties.shape === 'rectangle' ? '8%' : '50%' }}
        />
        <span className="sb-lamp-label">{properties.label || component.name || 'LAMP'}</span>
        <span className="sb-lamp-state">{qualityLabel || (tag ? (active ? 'ON' : 'OFF') : 'UNBOUND')}</span>
      </div>
    )
  }

  if (component.type === 'value-span') {
    const severity = valueSeverity(value, properties)
    const color = severity === 'critical' ? properties.criticalColor : severity === 'warning' ? properties.warningColor : properties.textColor
    return (
      <div className={`sb-value-component severity-${severity} quality-${quality}`} style={{ color, background: properties.backgroundColor }} title={`${tag?.name || 'Unbound'} · ${quality}`}>
        <span className="sb-value-label">{properties.label || component.name}</span>
        <strong>{formatRuntimeValue(value, properties)}</strong>
        <small>{qualityLabel || tag?.unit || ''}</small>
      </div>
    )
  }

  if (component.type === 'tuning-slider') {
    return <TuningSlider component={component} tag={tag} value={value} quality={quality} editable={editable} actorRole={actorRole} onCommand={onCommand} commandResult={commandResult} commandConnectionAvailable={commandConnectionAvailable} operationLockLabel={operationLockLabel} />
  }

  if (component.type === 'operation-shifter') {
    return <OperationShifter component={component} tag={tag} value={value} quality={quality} editable={editable} actorRole={actorRole} onCommand={onCommand} commandResult={commandResult} commandConnectionAvailable={commandConnectionAvailable} mode={operationMode} onModeChange={onOperationModeChange} />
  }

  if (component.type === 'chart') {
    return (
      <button
        type="button"
        className="sb-chart-launcher"
        aria-label={`Open ${properties.label || component.name || 'Chart'}${chartTags?.length ? `, ${chartTags.length} series` : ''}`}
        onPointerDown={event => { if (!editable) event.stopPropagation() }}
        onClick={event => {
          if (editable) return
          event.stopPropagation()
          onExpandChart?.()
        }}
      >
        Chart
      </button>
    )
  }

  if (component.type === 'control-popup') {
    return (
      <button
        type="button"
        className="sb-control-popup-launcher"
        aria-haspopup="dialog"
        disabled={editable}
        onPointerDown={event => { if (!editable) event.stopPropagation() }}
        onClick={event => {
          if (editable) return
          event.stopPropagation()
          onOpenPopup?.(event.currentTarget)
        }}
      >
        <strong>{properties.triggerLabel || properties.label || component.name || 'OPEN CONTROLS'}</strong>
        <span>{Array.isArray(component.children) ? component.children.length : 0} CONTROLS</span>
      </button>
    )
  }

  if (component.type === 'control-button') {
    const permitted = canExecuteCommand(actorRole, properties.requiredRole)
    const commandUi = commandUiState({
      tag,
      quality,
      editable,
      hasCommandHandler: Boolean(onCommand),
      permitted,
      connectionAvailable: commandConnectionAvailable,
      commandState: visibleCommandState,
      interlockLabel: operationLockLabel,
    })
    const runCommand = async event => {
      event.stopPropagation()
      if (commandUi.disabled) return
      if (properties.confirmation === 'single' && !window.confirm(`Send command “${properties.label || component.name}”?`)) return
      setCommandState('requested')
      let terminalState = 'failed'
      try {
        const result = await onCommand(component, tag)
        terminalState = result?.status || (result?.ok ? 'acknowledged' : 'failed')
      } catch {
        terminalState = 'failed'
      }
      setCommandState(terminalState)
      window.setTimeout(() => setCommandState('idle'), commandResultRetentionMs(terminalState))
    }
    return (
      <button type="button" className={`sb-control-component state-${commandUi.label.toLowerCase().replaceAll(' ', '-')}`} style={{ '--button-color': properties.buttonColor || '#f6b73c' }} disabled={commandUi.disabled} onClick={runCommand}>
        <strong>{isPendingCommandStatus(visibleCommandState) ? 'SENDING…' : properties.label || component.name}</strong>
        <span>{commandUi.label}</span>
      </button>
    )
  }

  if (component.type === 'text-label') {
    const fontSize = Math.max(6, Math.min(300, Number(properties.fontSize) || 32))
    const componentHeight = Math.max(1, Number(component.position?.height) || 72)
    const verticalAlign = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[properties.verticalAlign] || 'center'
    return (
      <div
        className="sb-text-component"
        style={{
          color: properties.textColor || '#dce8ef',
          background: properties.transparentBackground === false ? (properties.backgroundColor || '#101418') : 'transparent',
          fontSize: `${fontSize / componentHeight * 100}cqh`,
          fontWeight: properties.fontWeight || 700,
          fontStyle: properties.fontStyle || 'normal',
          fontFamily: properties.fontFamily || 'sans-serif',
          textAlign: properties.textAlign || 'left',
          justifyContent: verticalAlign,
        }}
      >
        <span>{properties.text || (editable ? 'NEW TEXT' : '')}</span>
      </div>
    )
  }
  if (component.type === 'design-image') {
    return designAsset?.src
      ? <div className="sb-design-image-component" style={{ opacity: properties.opacity ?? 1 }}><img src={designAsset.src} alt={editable ? component.name || designAsset.name : ''} draggable="false" style={{ objectFit: properties.objectFit || 'contain' }} /></div>
      : <div className="sb-design-image-missing" role="status">IMAGE UNAVAILABLE</div>
  }
  return <div className="sb-invalid-component">Unsupported component</div>
}

function ControlPopupDialog({ component, childComponents, tags, values, qualities, actorRole, onCommand, commandResults, commandConnectionAvailable, operationModes, onOperationModeChange, operationLockFor, componentById, onClose }) {
  const dialogRef = useRef(null)
  const closeRef = useRef(null)
  const properties = component.properties || {}
  const columns = Math.max(1, Math.min(3, Number(properties.columns) || 2))

  useEffect(() => { closeRef.current?.focus() }, [])
  useEffect(() => {
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const trapFocus = event => {
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])]
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return (
    <div
      className="sb-control-popup-backdrop"
      onPointerDown={event => {
        event.stopPropagation()
        if (event.target === event.currentTarget && properties.closeOnBackdrop !== false) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="sb-control-popup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={properties.label || component.name || 'Controls'}
        style={{ '--popup-columns': columns, '--popup-width': `${Math.max(360, Math.min(1200, Number(properties.dialogWidth) || 720))}px` }}
        onKeyDown={trapFocus}
        onPointerDown={event => event.stopPropagation()}
      >
        <header>
          <div><span>OPERATOR CONTROL MENU</span><strong>{properties.label || component.name || 'CONTROLS'}</strong></div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close control menu">× Close</button>
        </header>
        <div className="sb-control-popup-grid">
          {childComponents.map(child => {
            const tag = tags.get(child.binding?.tagId)
            const quality = qualities[child.binding?.tagId] || 'good'
            return (
              <div className={`sb-control-popup-item type-${child.type}`} key={child.id}>
                <RuntimeComponentBoundary componentName={child.name}>
                  <RuntimeComponent
                    component={child}
                    tag={tag}
                    value={values[child.binding?.tagId]}
                    quality={quality}
                    chartTags={[]}
                    editable={false}
                    actorRole={actorRole}
                    onCommand={onCommand}
                    commandResult={commandResults[child.id]}
                    commandConnectionAvailable={commandConnectionAvailable}
                    operationMode={operationModes[child.id] || 'manual'}
                    onOperationModeChange={mode => onOperationModeChange(child.id, mode)}
                    operationLockLabel={operationLockFor(child.id)}
                    componentById={componentById}
                  />
                </RuntimeComponentBoundary>
              </div>
            )
          })}
          {childComponents.length === 0 && <div className="sb-control-popup-empty"><strong>NO CONTROLS</strong><span>Add a Button or Slider in Builder.</span></div>}
        </div>
      </section>
    </div>
  )
}

function ExpandedChart({ component, tags, histories, historyStorage, onClose }) {
  const closeRef = useRef(null)
  useEffect(() => { closeRef.current?.focus() }, [])
  return (
    <section className="sb-chart-fullscreen" role="dialog" aria-modal="true" aria-label={component.properties?.label || component.name || 'Telemetry chart'} onPointerDown={event => event.stopPropagation()}>
      <header>
        <div>
          <span>LIVE TELEMETRY · {historyStorageLabel(historyStorage)}</span>
          <strong>{component.properties?.label || component.name || 'TELEMETRY CHART'}</strong>
        </div>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Minimize chart"><span aria-hidden="true">—</span> Minimize</button>
      </header>
      <TelemetryChart tags={tags} histories={histories} properties={component.properties} />
    </section>
  )
}

function historyStorageLabel(storage) {
  if (storage?.state === 'ready') return 'ARCHIVE READY'
  if (storage?.state === 'degraded') return 'ARCHIVE DEGRADED'
  if (storage?.state === 'configured') return 'ARCHIVE CONFIGURED'
  return 'SESSION ONLY'
}

function withCurrentChartSamples(component, histories, values, qualities) {
  const next = { ...histories }
  const now = Date.now()
  for (const tagId of component.binding?.tagIds || []) {
    if (next[tagId]?.length || !Number.isFinite(Number(values[tagId]))) continue
    next[tagId] = [{ timestamp: now, value: Number(values[tagId]), quality: qualities[tagId] || 'good', sequence: null }]
  }
  return next
}

function OperationShifter({ component, tag, quality, editable, actorRole, onCommand, commandResult, commandConnectionAvailable, mode, onModeChange }) {
  const properties = component.properties || {}
  const sequence = Array.isArray(properties.autoSequence) ? properties.autoSequence : []
  const [enabledStepIds, setEnabledStepIds] = useState(() => new Set(sequence.filter(step => step.enabled !== false).map(step => step.id)))
  const [commandState, setCommandState] = useState('idle')
  const [menuOpen, setMenuOpen] = useState(false)
  const shifterRef = useRef(null)
  const visibleCommandState = commandResult?.status || commandState
  const permitted = canExecuteCommand(actorRole, properties.requiredRole)
  const commandUi = commandUiState({
    tag,
    quality,
    editable,
    hasCommandHandler: Boolean(onCommand),
    permitted,
    connectionAvailable: commandConnectionAvailable,
    commandState: visibleCommandState,
  })

  useEffect(() => {
    setEnabledStepIds(previous => new Set(sequence.filter(step => step.enabled !== false && (previous.has(step.id) || !previous.size)).map(step => step.id)))
  }, [component.id, properties.autoSequence])

  useEffect(() => {
    if (!menuOpen) return undefined
    const closeOnOutsidePointer = event => {
      if (!shifterRef.current?.contains(event.target)) setMenuOpen(false)
    }
    const closeOnEscape = event => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  useEffect(() => {
    if (editable || commandUi.disabled) setMenuOpen(false)
  }, [editable, commandUi.disabled])

  const shift = async nextMode => {
    if (commandUi.disabled || nextMode === mode) return
    if (nextMode === 'auto' && enabledStepIds.size === 0) return
    const question = nextMode === 'reset'
      ? `RESET “${properties.label || component.name}”? The active sequence will stop and outputs should enter their configured steady state.`
      : `Switch “${properties.label || component.name}” to ${nextMode.toUpperCase()} mode?`
    if (properties.confirmation === 'single' && !window.confirm(question)) return
    setCommandState('requested')
    let terminalState = 'failed'
    try {
      const result = await onCommand(component, tag, { mode: nextMode, enabledStepIds: [...enabledStepIds] })
      terminalState = result?.status || (result?.ok ? 'acknowledged' : 'failed')
      if (result?.ok) onModeChange?.(nextMode)
    } catch {
      terminalState = 'failed'
    }
    setCommandState(terminalState)
    window.setTimeout(() => setCommandState('idle'), commandResultRetentionMs(terminalState))
  }

  const modeColors = {
    auto: properties.autoColor || '#22c55e',
    manual: properties.manualColor || '#3b82f6',
    reset: properties.resetColor || '#ef4444',
  }
  const modes = [['auto', modeColors.auto], ['manual', modeColors.manual], ['reset', modeColors.reset]]
  const statusLabel = isPendingCommandStatus(visibleCommandState) ? 'SHIFTING…' : mode.toUpperCase()

  return (
    <div ref={shifterRef} className={`sb-operation-shifter mode-${mode} state-${visibleCommandState} ${menuOpen ? 'is-open' : ''}`} style={{
      '--active-mode-color': modeColors[mode] || modeColors.manual,
      '--shifter-dark-bg': properties.darkButtonBackground || '#151719',
      '--shifter-dark-text': properties.darkButtonText || '#f0f3f4',
      '--shifter-dark-border': properties.darkButtonBorder || '#3d4246',
      '--shifter-light-bg': properties.lightButtonBackground || '#e9ece9',
      '--shifter-light-text': properties.lightButtonText || '#172229',
      '--shifter-light-border': properties.lightButtonBorder || '#747f85',
    }}>
      <button
        type="button"
        className="sb-operation-shifter-trigger"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`${properties.label || component.name}: ${statusLabel}`}
        disabled={!editable && commandUi.disabled}
        onPointerDown={event => { if (!editable) event.stopPropagation() }}
        onClick={event => {
          if (editable) return
          event.stopPropagation()
          setMenuOpen(open => !open)
        }}
      >
        <strong>{properties.label || component.name}</strong>
        <span>{statusLabel}</span>
      </button>
      {menuOpen && (
        <div className="sb-operation-shifter-menu" role="menu" aria-label="Operation mode" onPointerDown={event => event.stopPropagation()}>
          {modes.map(([nextMode, color]) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={mode === nextMode}
              key={nextMode}
              className={`sb-operation-mode-option ${mode === nextMode ? 'is-active' : ''}`}
              style={{ '--mode-color': color }}
              disabled={commandUi.disabled || (nextMode === 'auto' && enabledStepIds.size === 0)}
              title={nextMode === 'auto' && enabledStepIds.size === 0 ? 'Configure at least one enabled AUTO sequence step in Builder.' : undefined}
              onClick={event => {
                event.stopPropagation()
                setMenuOpen(false)
                void shift(nextMode)
              }}
            >
              {nextMode.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TuningSlider({ component, tag, value, quality, editable, actorRole, onCommand, commandResult, commandConnectionAvailable, operationLockLabel = '' }) {
  const properties = component.properties || {}
  const min = finiteNumber(properties.min, 0)
  const configuredMax = finiteNumber(properties.max, 100)
  const max = configuredMax > min ? configuredMax : min + 100
  const step = Math.max(0.000001, finiteNumber(properties.step, 1))
  const decimals = Math.max(0, Math.min(8, Number.parseInt(properties.decimals ?? 0, 10) || 0))
  const liveValue = Number.isFinite(Number(value)) ? Number(value) : null
  const [draft, setDraft] = useState(() => normalizeTuningValue(liveValue ?? min, min, max, step))
  const [dirty, setDirty] = useState(false)
  const [editing, setEditing] = useState(false)
  const [commandState, setCommandState] = useState('idle')
  const [appliedTarget, setAppliedTarget] = useState(null)
  const visibleCommandState = commandResult?.status || commandState
  const permitted = canExecuteCommand(actorRole, properties.requiredRole)
  const commandUi = commandUiState({
    tag,
    quality,
    editable,
    hasCommandHandler: Boolean(onCommand),
    permitted,
    connectionAvailable: commandConnectionAvailable,
    commandState: visibleCommandState,
    interlockLabel: operationLockLabel,
  })
  const targetPending = appliedTarget !== null
    && liveValue !== null
    && Math.abs(liveValue - appliedTarget) > Math.max(step / 2, 1e-7)
  const tuningUi = tuningInteractionState({ dirty, editing, commandState: visibleCommandState, fallbackLabel: targetPending ? 'RAMPING' : commandUi.label })
  const progressPercent = max === min ? 0 : Math.min(100, Math.max(0, ((draft - min) / (max - min)) * 100))

  useEffect(() => {
    if (!tuningUi.syncFromLive || targetPending) return
    setDraft(normalizeTuningValue(liveValue ?? min, min, max, step))
  }, [liveValue, min, max, step, targetPending, tuningUi.syncFromLive])

  useEffect(() => {
    if (appliedTarget === null || liveValue === null || targetPending) return
    setAppliedTarget(null)
  }, [appliedTarget, liveValue, targetPending])

  const updateDraft = event => {
    event.stopPropagation()
    setDraft(normalizeTuningValue(event.currentTarget.value, min, max, step))
    setDirty(true)
    setCommandState('idle')
  }
  const beginEditing = event => {
    event.stopPropagation()
    setEditing(true)
  }
  const finishEditing = event => {
    event.stopPropagation()
    setEditing(false)
  }
  const apply = async event => {
    event.stopPropagation()
    if (commandUi.disabled || !dirty) return
    if (properties.confirmation === 'single' && !window.confirm(`Apply ${formatTuningValue(draft, decimals)}${properties.suffix || ''} to “${properties.label || component.name}”?`)) return
    setCommandState('requested')
    let terminalState = 'failed'
    try {
      const result = await onCommand(component, tag, draft)
      terminalState = result?.status || (result?.ok ? 'acknowledged' : 'failed')
      if (result?.ok) {
        setAppliedTarget(draft)
        setDirty(false)
        setEditing(false)
      }
    } catch {
      terminalState = 'failed'
    }
    setCommandState(terminalState)
    window.setTimeout(() => setCommandState('idle'), commandResultRetentionMs(terminalState))
  }

  return (
    <div className={`sb-tuning-component state-${visibleCommandState} quality-${quality} ${editing ? 'is-editing' : ''} ${dirty ? 'is-dirty' : ''}`} style={{ '--tuning-accent': properties.accentColor || '#20c4d9' }}>
      <div className="sb-tuning-head">
        <span><strong>{properties.label || component.name || 'SETPOINT'}</strong><small>{tag?.name || 'UNBOUND'}</small></span>
        <span className="sb-tuning-value">{formatTuningValue(draft, decimals)}<small>{properties.suffix || ''}</small></span>
      </div>
      <input
        type="range"
        aria-label={`${properties.label || component.name || 'Setpoint'} tuning value`}
        min={min}
        max={max}
        step={step}
        value={draft}
        style={{ '--tuning-progress': `${progressPercent}%` }}
        disabled={commandUi.disabled}
        onInput={updateDraft}
        onPointerDown={beginEditing}
        onPointerUp={finishEditing}
        onPointerCancel={finishEditing}
        onKeyDown={beginEditing}
        onKeyUp={finishEditing}
        onBlur={() => setEditing(false)}
      />
      <div className="sb-tuning-footer">
        <span>{formatTuningValue(min, decimals)}</span>
        <span className="sb-tuning-live">LIVE {liveValue === null ? '--' : formatTuningValue(liveValue, decimals)}{properties.suffix || ''}</span>
        <span>{formatTuningValue(max, decimals)}</span>
        <button type="button" disabled={commandUi.disabled || !dirty} onPointerDown={event => event.stopPropagation()} onClick={apply}>{tuningUi.status}</button>
      </div>
    </div>
  )
}

export function snapValue(value, gridSize) {
  const size = Number(gridSize)
  return Number.isFinite(size) && size > 0 ? Math.round(value / size) * size : value
}

function canExecuteCommand(actorRole, requiredRole = 'OPERATOR') {
  if (requiredRole === 'VIEWER') return Boolean(actorRole)
  if (requiredRole === 'EDITOR') return ['OWNER', 'ADMIN', 'EDITOR'].includes(actorRole)
  return ['OWNER', 'ADMIN', 'OPERATOR'].includes(actorRole)
}

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeTuningValue(value, min, max, step) {
  const number = finiteNumber(value, min)
  const clamped = Math.min(max, Math.max(min, number))
  const aligned = min + Math.round((clamped - min) / step) * step
  return Number(Math.min(max, Math.max(min, aligned)).toFixed(10))
}

function formatTuningValue(value, decimals) {
  return finiteNumber(value, 0).toFixed(decimals)
}
