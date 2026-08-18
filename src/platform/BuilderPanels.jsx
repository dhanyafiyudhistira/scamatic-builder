import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { COMPONENT_REGISTRY, compatibleTags } from '../../shared/component-registry.js'
import { initialMockValue, RULE_OPERATORS } from '../../shared/runtime-evaluator.js'
import { CONTROL_POPUP_CHILD_TYPES, CONTROL_POPUP_MAX_CHILDREN, popupOwnerMap, rootRuntimeComponents } from '../../shared/control-popup.js'
import { tagUsageCounts } from '../../shared/tag-bindings.js'
import { numericEngineering, numericFormatMode, numericWriteConstraints, resolveGaugeZones, resolveNumericRange } from '../../shared/numeric-tag-config.js'
import { describeAlarmRule, normalizeNumericAlarmRule, numericAlarmRule } from '../../shared/alarm.js'

export function ComponentLibrary({ onAdd }) {
  const definitions = Object.values(COMPONENT_REGISTRY).filter(definition => definition.library !== false)
  const listRef = useItemCountViewport('.sb-library-item', 5, definitions.map(definition => definition.type).join('|'))

  return (
    <div ref={listRef} className="sb-component-library" role="region" aria-label="Available components" tabIndex={0}>
      {definitions.map(definition => (
        <button type="button" className="sb-library-item" key={definition.type} onClick={() => onAdd(definition.type)}>
          <strong>{definition.label}</strong>
        </button>
      ))}
    </div>
  )
}

export function TagManager({ schema, values, onSchemaChange, onValuesChange }) {
  const [draftTag, setDraftTag] = useState({ name: '', dataType: 'boolean', access: 'read', sourceId: 'source_mock', path: '' })
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const usage = useMemo(() => tagUsageCounts(schema.components), [schema.components])
  const visibleTags = schema.tags.filter(tag => {
    const matchesQuery = !query || `${tag.name} ${tag.id}`.toLowerCase().includes(query.toLowerCase())
    return matchesQuery && (typeFilter === 'all' || tag.dataType === typeFilter)
  })
  const tagListKey = `${visibleTags.length}:${visibleTags.slice(0, 2).map(tag => tag.id).join('|')}`
  const tagListRef = useItemCountViewport('.sb-tag-card', 2, tagListKey)

  const addTag = event => {
    event.preventDefault()
    const name = draftTag.name.trim() || `Mock ${draftTag.dataType} ${schema.tags.length + 1}`
    const source = schema.dataSources.find(item => item.id === draftTag.sourceId) || schema.dataSources[0]
    const prefix = source?.type === 'mock' ? 'mock' : 'tb'
    const base = `${prefix}.${slugPart(name) || draftTag.dataType}`
    let id = base
    let suffix = 2
    while (schema.tags.some(tag => tag.id === id)) id = `${base}_${suffix++}`
    const tag = {
      id,
      name,
      path: draftTag.path.trim() || id,
      dataType: draftTag.dataType,
      access: draftTag.access,
      sourceId: source?.id || 'source_mock',
      freshnessMode: draftTag.access === 'write' ? 'event-driven' : 'periodic',
      adaptiveFreshness: draftTag.access !== 'write',
      staleAfterMs: 10000,
      ...(draftTag.dataType === 'number' ? {
        numberFormat: 'number',
        engineering: { min: 0, max: 100, unit: '', decimals: 1 },
        ...(draftTag.access !== 'read' ? { writeConstraints: { min: 0, max: 100, step: 1 } } : {}),
      } : {}),
    }
    onSchemaChange(previous => ({ ...previous, tags: [...previous.tags, tag] }))
    onValuesChange(previous => ({ ...previous, [id]: initialMockValue(tag) }))
    setDraftTag(previous => ({ ...previous, name: '', path: '' }))
  }

  const removeTag = tag => {
    if ((usage.get(tag.id) || 0) > 0) return
    onSchemaChange(previous => ({ ...previous, tags: previous.tags.filter(item => item.id !== tag.id) }))
    onValuesChange(previous => {
      const next = { ...previous }
      delete next[tag.id]
      return next
    })
  }
  const updateTag = (tagId, patch) => onSchemaChange(previous => ({ ...previous, tags: previous.tags.map(tag => tag.id === tagId ? { ...tag, ...patch } : tag) }))

  return (
    <div className="sb-tag-manager">
      <form className="sb-tag-create" onSubmit={addTag}>
        <input aria-label="New tag name" placeholder="Tag name" value={draftTag.name} onChange={event => setDraftTag(previous => ({ ...previous, name: event.target.value }))} />
        <select aria-label="New tag source" value={draftTag.sourceId} onChange={event => setDraftTag(previous => ({ ...previous, sourceId: event.target.value }))}>{schema.dataSources.map(source => <option value={source.id} key={source.id}>{source.id} · {source.type}</option>)}</select>
        {schema.dataSources.find(source => source.id === draftTag.sourceId)?.type !== 'mock' && <input aria-label="ThingsBoard telemetry key" placeholder="Telemetry key" value={draftTag.path} onChange={event => setDraftTag(previous => ({ ...previous, path: event.target.value }))} required />}
        <div className="sb-form-grid">
          <select aria-label="New tag data type" value={draftTag.dataType} onChange={event => setDraftTag(previous => ({ ...previous, dataType: event.target.value }))}>
            <option value="boolean">Boolean</option><option value="number">Number</option><option value="string">String</option><option value="enum">Enum</option><option value="datetime">Datetime</option>
          </select>
          <select aria-label="New tag access" value={draftTag.access} onChange={event => setDraftTag(previous => ({ ...previous, access: event.target.value }))}>
            <option value="read">Read</option><option value="read-write">Read/write</option><option value="write">Write</option>
          </select>
        </div>
        <button type="submit" className="sb-add-tag">+ Add tag</button>
      </form>
      <div className="sb-tag-filters"><input aria-label="Search tags" placeholder="Search tags…" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="Filter tag type" value={typeFilter} onChange={event => setTypeFilter(event.target.value)}><option value="all">All types</option><option value="boolean">Boolean</option><option value="number">Number</option><option value="string">String</option><option value="enum">Enum</option><option value="datetime">Datetime</option></select></div>
      <div ref={tagListRef} className="sb-tag-list" role="region" aria-label="Tags" tabIndex={0}>
        {visibleTags.map(tag => {
          const usageCount = usage.get(tag.id) || 0
          const engineering = numericEngineering(tag)
          const numberFormat = numericFormatMode(tag)
          const writeConstraints = numericWriteConstraints(tag)
          const alarmRuleEnabled = tag.alarmRule != null
          const alarmRule = normalizeNumericAlarmRule(tag.alarmRule, tag)
          return (
            <article key={tag.id} className="sb-tag-card">
              <header className="sb-tag-card-head">
                <span className="sb-tag-identity">
                  <strong>{tag.name}</strong>
                  <code title={tag.id}>{tag.id}</code>
                </span>
                <span className={`sb-tag-type type-${tag.dataType}`}>{tag.dataType}</span>
              </header>
              <div className="sb-tag-field-grid">
                <label>
                  <span>Source</span>
                  <select aria-label={`${tag.name} source`} title={tag.sourceId} value={tag.sourceId} onChange={event => updateTag(tag.id, { sourceId: event.target.value })}>
                    {schema.dataSources.map(source => <option value={source.id} key={source.id}>{sourceOptionLabel(source)}</option>)}
                  </select>
                </label>
                <label>
                  <span>Access</span>
                  <select aria-label={`${tag.name} access`} value={tag.access} onChange={event => {
                    const access = event.target.value
                    updateTag(tag.id, {
                      access,
                      ...(tag.dataType === 'number' && access !== 'read' && !tag.writeConstraints ? { writeConstraints: { min: engineering.min, max: engineering.max, step: 1 } } : {}),
                    })
                  }}>
                    <option value="read">Read</option><option value="read-write">Read/write</option><option value="write">Write</option>
                  </select>
                </label>
                <label className="sb-tag-path-field">
                  <span>Path / telemetry key</span>
                  <input aria-label={`${tag.name} path`} value={tag.path} onChange={event => updateTag(tag.id, { path: event.target.value })} />
                </label>
                {tag.dataType === 'number' && <>
                  <label><span>Number display</span><select aria-label={`${tag.name} number display`} value={numberFormat} onChange={event => {
                    const nextFormat = event.target.value
                    updateTag(tag.id, {
                      numberFormat: nextFormat,
                      engineering: { ...engineering, unit: nextFormat === 'percentage' ? '%' : engineering.unit === '%' ? '' : engineering.unit },
                    })
                  }}><option value="number">Normal number</option><option value="percentage">Percentage (%)</option></select></label>
                  <label><span>Engineering min</span><input aria-label={`${tag.name} engineering minimum`} type="number" step="any" value={engineering.min} onChange={event => updateTag(tag.id, { engineering: { ...engineering, min: Number(event.target.value) } })} /></label>
                  <label><span>Engineering max</span><input aria-label={`${tag.name} engineering maximum`} type="number" step="any" value={engineering.max} onChange={event => updateTag(tag.id, { engineering: { ...engineering, max: Number(event.target.value) } })} /></label>
                  <label><span>Engineering unit</span><input aria-label={`${tag.name} engineering unit`} value={engineering.unit} placeholder="°C, bar, rpm" maxLength={40} disabled={numberFormat === 'percentage'} onChange={event => updateTag(tag.id, { engineering: { ...engineering, unit: event.target.value } })} /></label>
                  <label><span>Engineering decimals</span><input aria-label={`${tag.name} engineering decimals`} type="number" min="0" max="8" step="1" value={engineering.decimals} onChange={event => updateTag(tag.id, { engineering: { ...engineering, decimals: Number(event.target.value) } })} /></label>
                  {tag.access !== 'read' && <>
                    <label><span>Command min</span><input aria-label={`${tag.name} command minimum`} type="number" min={engineering.min} max={engineering.max} step="any" value={writeConstraints.min} onChange={event => updateTag(tag.id, { writeConstraints: { ...writeConstraints, min: Number(event.target.value) } })} /></label>
                    <label><span>Command max</span><input aria-label={`${tag.name} command maximum`} type="number" min={engineering.min} max={engineering.max} step="any" value={writeConstraints.max} onChange={event => updateTag(tag.id, { writeConstraints: { ...writeConstraints, max: Number(event.target.value) } })} /></label>
                    <label><span>Command step</span><input aria-label={`${tag.name} command step`} type="number" min="0.000001" step="any" value={writeConstraints.step} onChange={event => updateTag(tag.id, { writeConstraints: { ...writeConstraints, step: Number(event.target.value) } })} /></label>
                  </>}
                  <fieldset className="sb-tag-alarm-setup">
                    <legend>Alarm trigger</legend>
                    <label><span>React when</span><select aria-label={`${tag.name} alarm condition`} value={alarmRuleEnabled ? alarmRule.operator : 'none'} onChange={event => updateTag(tag.id, { alarmRule: event.target.value === 'none' ? null : normalizeNumericAlarmRule({ operator: event.target.value }, tag) })}><option value="none">Not configured</option><option value="gte">At or above (≥)</option><option value="gt">Above (&gt;)</option><option value="lte">At or below (≤)</option><option value="lt">Below (&lt;)</option><option value="eq">Equal to (=)</option><option value="neq">Not equal to (≠)</option><option value="between">Inside range</option><option value="outside">Outside range</option></select></label>
                    {alarmRuleEnabled && !['between', 'outside'].includes(alarmRule.operator) && <label><span>Trigger value</span><input aria-label={`${tag.name} alarm trigger value`} type="number" min={engineering.min} max={engineering.max} step="any" value={alarmRule.value} onChange={event => updateTag(tag.id, { alarmRule: { ...alarmRule, value: Number(event.target.value) } })} /></label>}
                    {alarmRuleEnabled && ['between', 'outside'].includes(alarmRule.operator) && <>
                      <label><span>Range minimum</span><input aria-label={`${tag.name} alarm range minimum`} type="number" min={engineering.min} max={engineering.max} step="any" value={alarmRule.min} onChange={event => updateTag(tag.id, { alarmRule: { ...alarmRule, min: Number(event.target.value) } })} /></label>
                      <label><span>Range maximum</span><input aria-label={`${tag.name} alarm range maximum`} type="number" min={engineering.min} max={engineering.max} step="any" value={alarmRule.max} onChange={event => updateTag(tag.id, { alarmRule: { ...alarmRule, max: Number(event.target.value) } })} /></label>
                    </>}
                    <small>{alarmRuleEnabled ? `Alarm reacts at ${describeAlarmRule(alarmRule, engineering.unit)}.` : 'Alarm components may use their own custom rule.'}</small>
                  </fieldset>
                </>}
                {schema.dataSources.find(source => source.id === tag.sourceId)?.type !== 'mock' && <>
                  <label>
                    <span>Freshness</span>
                    <select aria-label={`${tag.name} freshness mode`} value={tag.freshnessMode || 'periodic'} onChange={event => updateTag(tag.id, { freshnessMode: event.target.value })}>
                      <option value="periodic">Periodic</option><option value="event-driven">Event-driven</option>
                    </select>
                  </label>
                  {tag.freshnessMode !== 'event-driven' && <label>
                    <span>Stale floor (ms)</span>
                    <input aria-label={`${tag.name} stale floor`} type="number" min="1000" max="86400000" step="1000" value={tag.staleAfterMs || 10000} onChange={event => updateTag(tag.id, { staleAfterMs: Number(event.target.value) })} />
                  </label>}
                  {tag.freshnessMode !== 'event-driven' && <label className="sb-check">
                    <input aria-label={`${tag.name} adaptive freshness`} type="checkbox" checked={tag.adaptiveFreshness !== false} onChange={event => updateTag(tag.id, { adaptiveFreshness: event.target.checked })} />
                    Adaptive threshold
                  </label>}
                </>}
              </div>
              <footer className="sb-tag-card-footer">
                <label className="sb-tag-value-field">
                  <span>Simulation</span>
                  <span className="sb-tag-value-control"><MockValueInput tag={tag} value={values[tag.id]} onChange={value => onValuesChange(previous => ({ ...previous, [tag.id]: value }))} compact /></span>
                </label>
                <span className={`sb-usage-count ${usageCount > 0 ? 'is-used' : ''}`} title={`${usageCount} component bindings`}>{usageCount} {usageCount === 1 ? 'binding' : 'bindings'}</span>
                <button type="button" className="sb-tag-delete" title={usageCount > 0 ? 'Remove all component bindings before deleting this tag' : `Delete ${tag.name}`} disabled={usageCount > 0} onClick={() => removeTag(tag)}>Delete</button>
              </footer>
            </article>
          )
        })}
        {visibleTags.length === 0 && <p className="sb-muted">No tags match the current filter.</p>}
      </div>
    </div>
  )
}

function useItemCountViewport(itemSelector, visibleItemCount, contentKey) {
  const listRef = useRef(null)

  useEffect(() => {
    const list = listRef.current
    if (!list) return undefined

    const items = Array.from(list.children).filter(item => item.matches(itemSelector))
    const measuredItems = items.slice(0, visibleItemCount)
    const syncViewport = () => {
      if (items.length <= visibleItemCount) {
        list.style.setProperty('--sb-list-viewport-size', 'none')
        return
      }

      const styles = getComputedStyle(list)
      const gap = Number.parseFloat(styles.rowGap || styles.gap) || 0
      const itemHeight = measuredItems.reduce((total, item) => total + item.getBoundingClientRect().height, 0)
      if (itemHeight > 0) {
        list.style.setProperty('--sb-list-viewport-size', `${Math.ceil(itemHeight + gap * (measuredItems.length - 1))}px`)
      }
    }

    syncViewport()
    if (typeof ResizeObserver === 'undefined') return undefined

    const observer = new ResizeObserver(syncViewport)
    measuredItems.forEach(item => observer.observe(item))
    return () => observer.disconnect()
  }, [contentKey, itemSelector, visibleItemCount])

  return listRef
}

export function LayersPanel({ components, selectedIds, onSelect, onPatch, onReorder }) {
  const byId = new Map(components.map(component => [component.id, component]))
  const ordered = rootRuntimeComponents(components).sort((left, right) => (right.zIndex || 0) - (left.zIndex || 0))
  const row = (component, child = false) => (
    <div className={`sb-layer-row ${child ? 'is-child' : ''} ${selectedIds.includes(component.id) ? 'is-selected' : ''}`} key={component.id}>
      <button type="button" className="sb-layer-name" onClick={event => onSelect(component.id, { additive: event.shiftKey || event.ctrlKey || event.metaKey })}>
        {component.name}
      </button>
      <button type="button" className="sb-icon-button" title={component.visible === false ? 'Show layer' : 'Hide layer'} onClick={() => onPatch(component.id, { visible: component.visible === false })}>{component.visible === false ? '○' : '●'}</button>
      <button type="button" className="sb-icon-button" title={component.locked ? 'Unlock layer' : 'Lock layer'} onClick={() => onPatch(component.id, { locked: !component.locked })}>{component.locked ? '▣' : '□'}</button>
      {!child && <button type="button" className="sb-icon-button" title="Bring forward" onClick={() => onReorder(component.id, 1)}>↑</button>}
      {!child && <button type="button" className="sb-icon-button" title="Send backward" onClick={() => onReorder(component.id, -1)}>↓</button>}
    </div>
  )
  return (
    <div className="sb-layers">
      {ordered.map(component => (
        <Fragment key={component.id}>
          {row(component)}
          {component.type === 'control-popup' && (Array.isArray(component.children) ? component.children : []).map(childId => byId.get(childId)).filter(Boolean).map(child => row(child, true))}
        </Fragment>
      ))}
      {components.length === 0 && <p className="sb-muted">No component layers yet.</p>}
    </div>
  )
}

export function ComponentInspector({ component, components = [], tags, onChange, onDelete, onDuplicate, onAddPopupChild, onCreatePopupChild, onDetachPopupChild, onReorderPopupChild, onSelectChild }) {
  const setPosition = (key, value) => onChange({ position: { ...component.position, [key]: Number(value) } })
  const setProperty = (key, value) => onChange({ properties: { ...component.properties, [key]: value } })
  const setProperties = patch => onChange({ properties: { ...component.properties, ...patch } })
  const compatible = compatibleTags(component.type, tags)
  const availableTags = ['control-button', 'tuning-slider', 'operation-shifter'].includes(component.type)
    ? compatible.filter(tag => ['write', 'read-write'].includes(tag.access))
    : compatible
  const boundTag = tags.find(tag => tag.id === component.binding?.tagId)
  return (
    <div className="sb-inspector">
      <label>Name<input value={component.name} onChange={event => onChange({ name: event.target.value })} /></label>
      {!['text-label', 'design-image'].includes(component.type) && <label>Label<input value={component.properties?.label || ''} onChange={event => setProperty('label', event.target.value)} /></label>}
      {!['text-label', 'design-image', 'chart', 'control-popup'].includes(component.type) && <label>Tag binding<select value={component.binding?.tagId || ''} onChange={event => onChange({ binding: { tagId: event.target.value || null } })}><option value="">Unbound</option>{availableTags.map(tag => <option value={tag.id} key={tag.id}>{tag.name} · {tag.dataType}</option>)}</select></label>}
      <div className="sb-form-grid">
        <NumberField label="X" value={component.position.x} onChange={value => setPosition('x', value)} />
        <NumberField label="Y" value={component.position.y} onChange={value => setPosition('y', value)} />
        <NumberField label="Width" value={component.position.width} min={24} onChange={value => setPosition('width', value)} />
        <NumberField label="Height" value={component.position.height} min={24} onChange={value => setPosition('height', value)} />
        <NumberField label="Rotation" value={component.position.rotation} onChange={value => setPosition('rotation', value)} />
        <NumberField label="Layer" value={component.zIndex || 1} min={1} onChange={value => onChange({ zIndex: value })} />
      </div>
      <label className="sb-check"><input type="checkbox" checked={component.visible !== false} onChange={event => onChange({ visible: event.target.checked })} /> Visible</label>
      <label className="sb-check"><input type="checkbox" checked={Boolean(component.locked)} onChange={event => onChange({ locked: event.target.checked })} /> Locked</label>
      {component.type === 'indicator-lamp' && <LampProperties component={component} setProperty={setProperty} />}
      {component.type === 'alarm' && <AlarmProperties component={component} tag={boundTag} setProperty={setProperty} />}
      {component.type === 'value-span' && <ValueProperties component={component} tag={boundTag} setProperty={setProperty} />}
      {component.type === 'gauge' && <GaugeProperties component={component} tag={boundTag} setProperty={setProperty} setProperties={setProperties} />}
      {component.type === 'control-button' && <ButtonProperties component={component} tags={tags} setProperty={setProperty} />}
      {component.type === 'tuning-slider' && <TuningProperties component={component} tag={boundTag} tags={tags} setProperty={setProperty} setProperties={setProperties} />}
      {component.type === 'operation-shifter' && <OperationShifterProperties component={component} components={components} tags={tags} setProperty={setProperty} />}
      {component.type === 'control-popup' && <PopupProperties component={component} components={components} setProperty={setProperty} onAddChild={onAddPopupChild} onCreateChild={onCreatePopupChild} onDetachChild={onDetachPopupChild} onReorderChild={onReorderPopupChild} onSelectChild={onSelectChild} />}
      {component.type === 'chart' && <ChartProperties component={component} tags={availableTags} setProperty={setProperty} onChange={onChange} />}
      {component.type === 'text-label' && <TextProperties component={component} setProperty={setProperty} />}
      {component.type === 'design-image' && <DesignImageProperties component={component} setProperty={setProperty} />}
      <div className="sb-inspector-actions"><button type="button" onClick={onDuplicate}>Duplicate</button><button type="button" className="danger" onClick={onDelete}>Delete</button></div>
    </div>
  )
}

function InspectorGroup({ title, className = '', children }) {
  return (
    <details className={`sb-inspector-group ${className}`.trim()}>
      <summary><span>{title}</span><i aria-hidden="true" /></summary>
      <div className="sb-inspector-group-content">{children}</div>
    </details>
  )
}

function DesignImageProperties({ component, setProperty }) {
  return (
    <InspectorGroup title="Custom image">
      <label>Source<input value={component.properties?.fileName || 'Uploaded image'} readOnly /></label>
      <label>Fit<select value={component.properties?.objectFit || 'contain'} onChange={event => setProperty('objectFit', event.target.value)}><option value="contain">Contain</option><option value="cover">Cover</option><option value="fill">Stretch</option></select></label>
      <label className="sb-check"><input type="checkbox" checked={component.properties?.lockAspectRatio !== false} onChange={event => setProperty('lockAspectRatio', event.target.checked)} /> Lock aspect ratio on corner resize</label>
      <label>Opacity<input type="range" min="0" max="1" step="0.05" value={component.properties?.opacity ?? 1} onChange={event => setProperty('opacity', Number(event.target.value))} /><small>{Math.round((component.properties?.opacity ?? 1) * 100)}%</small></label>
    </InspectorGroup>
  )
}

function PopupProperties({ component, components, setProperty, onAddChild, onCreateChild, onDetachChild, onReorderChild, onSelectChild }) {
  const [candidateId, setCandidateId] = useState('')
  const owners = popupOwnerMap(components)
  const byId = new Map(components.map(item => [item.id, item]))
  const children = (Array.isArray(component.children) ? component.children : []).map(id => byId.get(id)).filter(Boolean)
  const available = components.filter(item => CONTROL_POPUP_CHILD_TYPES.has(item.type) && !owners.has(item.id))
  const full = children.length >= CONTROL_POPUP_MAX_CHILDREN
  const add = () => {
    if (!candidateId || full) return
    onAddChild?.(component.id, candidateId)
    setCandidateId('')
  }
  return (
    <InspectorGroup title="Pop-up menu" className="sb-popup-properties">
      <label>Launcher label<input value={component.properties?.triggerLabel || ''} onChange={event => setProperty('triggerLabel', event.target.value)} /></label>
      <div className="sb-form-grid">
        <NumberField label="Columns" value={component.properties?.columns ?? 2} min={1} max={3} onChange={value => setProperty('columns', value)} />
        <NumberField label="Dialog width" value={component.properties?.dialogWidth ?? 720} min={360} max={1200} onChange={value => setProperty('dialogWidth', value)} />
      </div>
      <label className="sb-check"><input type="checkbox" checked={component.properties?.closeOnBackdrop !== false} onChange={event => setProperty('closeOnBackdrop', event.target.checked)} /> Close when backdrop is clicked</label>
      <div className="sb-popup-add-existing">
        <select aria-label="Existing control to add" value={candidateId} onChange={event => setCandidateId(event.target.value)} disabled={full || available.length === 0}>
          <option value="">{available.length ? 'Choose existing control…' : 'No unassigned controls'}</option>
          {available.map(item => <option key={item.id} value={item.id}>{item.name} · {COMPONENT_REGISTRY[item.type]?.label}</option>)}
        </select>
        <button type="button" onClick={add} disabled={!candidateId || full}>+ Add</button>
      </div>
      <div className="sb-popup-create-actions">
        <button type="button" onClick={() => onCreateChild?.(component.id, 'control-button')} disabled={full}>+ New Button</button>
        <button type="button" onClick={() => onCreateChild?.(component.id, 'tuning-slider')} disabled={full}>+ New Slider</button>
      </div>
      <div className="sb-popup-child-list">
        {children.map((child, index) => (
          <div key={child.id}>
            <button type="button" className="sb-popup-child-name" onClick={() => onSelectChild?.(child.id)}>{child.name}</button>
            <button type="button" aria-label={`Move ${child.name} up`} disabled={index === 0} onClick={() => onReorderChild?.(component.id, child.id, -1)}>↑</button>
            <button type="button" aria-label={`Move ${child.name} down`} disabled={index === children.length - 1} onClick={() => onReorderChild?.(component.id, child.id, 1)}>↓</button>
            <button type="button" onClick={() => onDetachChild?.(component.id, child.id)}>Detach</button>
          </div>
        ))}
        {children.length === 0 && <p className="sb-muted">No controls yet. Add an existing control or create one directly.</p>}
      </div>
      <small>{children.length}/{CONTROL_POPUP_MAX_CHILDREN} controls · Sliders span the full row at runtime.</small>
    </InspectorGroup>
  )
}

function ChartProperties({ component, tags, setProperty, onChange }) {
  const selected = component.binding?.tagIds || []
  const toggleTag = tagId => {
    const next = selected.includes(tagId)
      ? selected.filter(id => id !== tagId)
      : [...selected, tagId].slice(0, 8)
    onChange({ binding: { tagId: null, tagIds: next } })
  }
  return (
    <InspectorGroup title="Telemetry series">
      <div className="sb-chart-tag-options">
        {tags.map(tag => (
          <label className="sb-check" key={tag.id}>
            <input type="checkbox" checked={selected.includes(tag.id)} disabled={!selected.includes(tag.id) && selected.length >= 8} onChange={() => toggleTag(tag.id)} />
            <span>{tag.name}<small>{tag.id}</small></span>
          </label>
        ))}
        {tags.length === 0 && <p className="sb-muted">Add a readable numeric tag first.</p>}
      </div>
      <small className="sb-chart-selection-count">{selected.length}/8 series selected</small>
      <div className="sb-form-grid">
        <NumberField label="History points" value={component.properties?.historyLimit ?? 300} min={30} max={2000} onChange={value => setProperty('historyLimit', value)} />
        <NumberField label="Window (minutes)" value={component.properties?.windowMinutes ?? 60} min={1} max={1440} onChange={value => setProperty('windowMinutes', value)} />
      </div>
      <label className="sb-check"><input type="checkbox" checked={component.properties?.showLegend !== false} onChange={event => setProperty('showLegend', event.target.checked)} /> Show legend</label>
    </InspectorGroup>
  )
}

function LampProperties({ component, setProperty }) {
  const rule = component.properties?.rule || { operator: 'truthy' }
  const setRule = patch => setProperty('rule', { ...rule, ...patch })
  return <InspectorGroup title="Lamp state"><label>Shape<select value={component.properties?.shape || 'circle'} onChange={event => setProperty('shape', event.target.value)}><option value="circle">Circle</option><option value="square">Rounded square</option><option value="rectangle">Rectangle</option></select></label><label>Rule<select value={rule.operator} onChange={event => setRule({ operator: event.target.value })}>{RULE_OPERATORS.map(operator => <option value={operator} key={operator}>{operator}</option>)}</select></label>{!['truthy', 'between', 'outside'].includes(rule.operator) && <label>Compare value<input value={rule.value ?? ''} onChange={event => setRule({ value: parseMaybeNumber(event.target.value) })} /></label>}{['between', 'outside'].includes(rule.operator) && <div className="sb-form-grid"><NumberField label="Minimum" value={rule.min ?? 0} onChange={value => setRule({ min: value })} /><NumberField label="Maximum" value={rule.max ?? 100} onChange={value => setRule({ max: value })} /></div>}<div className="sb-form-grid"><ColorField label="ON color" value={component.properties?.onColor || '#22c55e'} onChange={value => setProperty('onColor', value)} /><ColorField label="OFF color" value={component.properties?.offColor || '#64748b'} onChange={value => setProperty('offColor', value)} /></div><label className="sb-check"><input type="checkbox" checked={component.properties?.glow !== false} onChange={event => setProperty('glow', event.target.checked)} /> Glow when active</label></InspectorGroup>
}

function AlarmProperties({ component, tag, setProperty }) {
  const properties = component.properties || {}
  const rule = properties.rule || { operator: 'truthy' }
  const presentation = properties.presentation === 'buzzer' ? 'buzzer' : 'lamp'
  const canInherit = tag?.dataType === 'number'
  const ruleMode = canInherit && properties.ruleMode !== 'custom' ? 'inherit' : 'custom'
  const inheritedRule = numericAlarmRule(tag)
  const setRule = patch => setProperty('rule', { ...rule, ...patch })
  return (
    <InspectorGroup title="Alarm behavior">
      <label>Alarm type<select value={presentation} onChange={event => setProperty('presentation', event.target.value)}><option value="lamp">Lamp</option><option value="buzzer">Buzzer</option></select></label>
      {canInherit && <label>Trigger source<select value={ruleMode} onChange={event => setProperty('ruleMode', event.target.value)}><option value="inherit">Inherit from Tag</option><option value="custom">Custom for this Alarm</option></select></label>}
      {ruleMode === 'inherit' && <small className="sb-muted">{inheritedRule ? `Using Tag trigger: ${describeAlarmRule(inheritedRule, numericEngineering(tag).unit)}.` : 'This Tag has no Alarm trigger yet. Configure it under Tags & simulation; the component rule remains the fallback.'}</small>}
      {ruleMode === 'custom' && <>
        <label>Trigger rule<select value={rule.operator} onChange={event => setRule({ operator: event.target.value })}>{RULE_OPERATORS.map(operator => <option value={operator} key={operator}>{operator}</option>)}</select></label>
        {!['truthy', 'between', 'outside'].includes(rule.operator) && <label>Compare value<input value={rule.value ?? ''} onChange={event => setRule({ value: parseMaybeNumber(event.target.value) })} /></label>}
        {['between', 'outside'].includes(rule.operator) && <div className="sb-form-grid"><NumberField label="Minimum" value={rule.min ?? 0} onChange={value => setRule({ min: value })} /><NumberField label="Maximum" value={rule.max ?? 100} onChange={value => setRule({ max: value })} /></div>}
      </>}
      <div className="sb-form-grid">
        <ColorField label="Active color" value={properties.activeColor || '#ef4444'} onChange={value => setProperty('activeColor', value)} />
        <ColorField label="Idle color" value={properties.idleColor || '#46545d'} onChange={value => setProperty('idleColor', value)} />
      </div>
      <label className="sb-check"><input type="checkbox" checked={properties.flash !== false} onChange={event => setProperty('flash', event.target.checked)} /> Flash when active</label>
      {presentation === 'buzzer' && <>
        <label className="sb-check"><input type="checkbox" checked={properties.soundEnabled !== false} onChange={event => setProperty('soundEnabled', event.target.checked)} /> Enable sound in runtime</label>
        <div className="sb-form-grid">
          <NumberField label="Frequency (Hz)" value={properties.frequencyHz ?? 880} min={100} max={4000} onChange={value => setProperty('frequencyHz', value)} />
          <NumberField label="Volume (0–0.5)" value={properties.volume ?? 0.18} min={0} max={0.5} step="0.01" onChange={value => setProperty('volume', value)} />
          <NumberField label="Pulse interval (ms)" value={properties.pulseMs ?? 650} min={100} max={5000} onChange={value => setProperty('pulseMs', value)} />
        </div>
        <small className="sb-muted">Sound is muted while editing. At runtime, operators can silence the current alarm occurrence.</small>
      </>}
    </InspectorGroup>
  )
}

function ValueProperties({ component, tag, setProperty }) {
  const properties = component.properties || {}
  const engineering = numericEngineering(tag)
  return <InspectorGroup title="Value formatting">{tag?.dataType === 'number' && <small className="sb-muted">Tag engineering range: {engineering.min} – {engineering.max}{engineering.unit ? ` ${engineering.unit}` : ''}. Value Span reports out-of-range telemetry without clamping it.</small>}<div className="sb-form-grid"><label>Prefix<input value={properties.prefix || ''} onChange={event => setProperty('prefix', event.target.value)} /></label><label>Suffix<input value={properties.suffix || ''} placeholder={engineering.unit || undefined} onChange={event => setProperty('suffix', event.target.value)} /></label><NumberField label="Decimals" value={properties.decimals ?? engineering.decimals} min={0} max={8} onChange={value => setProperty('decimals', value)} /><NumberField label="Scale" value={properties.scale ?? 1} step="0.1" onChange={value => setProperty('scale', value)} /><NumberField label="Offset" value={properties.offset ?? 0} step="0.1" onChange={value => setProperty('offset', value)} /><label>Fallback<input value={properties.fallback ?? '--'} onChange={event => setProperty('fallback', event.target.value)} /></label></div><div className="sb-form-grid"><NumberField label="Warning high" value={properties.warningHigh ?? ''} allowEmpty onChange={value => setProperty('warningHigh', value)} /><NumberField label="Critical high" value={properties.criticalHigh ?? ''} allowEmpty onChange={value => setProperty('criticalHigh', value)} /><ColorField label="Normal color" value={properties.textColor || '#d8f7fa'} onChange={value => setProperty('textColor', value)} /><ColorField label="Background" value={properties.backgroundColor || '#0a1117'} onChange={value => setProperty('backgroundColor', value)} /></div></InspectorGroup>
}

function GaugeProperties({ component, tag, setProperty, setProperties }) {
  const properties = component.properties || {}
  const engineering = numericEngineering(tag)
  const range = resolveNumericRange(tag, properties, 'display')
  const zones = resolveGaugeZones(range, properties)
  const min = range.min
  const max = range.max
  const inherited = properties.rangeMode === 'inherit'
  const inheritedUnit = properties.unitMode !== 'custom'
  return (
    <InspectorGroup title="Gauge scale and appearance">
      <label>Scale range<select value={inherited ? 'inherit' : 'custom'} onChange={event => setProperties(event.target.value === 'inherit' ? { rangeMode: 'inherit' } : { rangeMode: 'custom', min, max })}><option value="inherit">Inherit from Tag</option><option value="custom">Custom display range</option></select></label>
      {inherited && <small className="sb-muted">Using Tag range {min} – {max}.</small>}
      <div className="sb-form-grid">
        <NumberField label="Minimum" value={inherited ? min : properties.min ?? min} disabled={inherited} onChange={value => setProperty('min', value)} />
        <NumberField label="Maximum" value={inherited ? max : properties.max ?? max} disabled={inherited} onChange={value => setProperty('max', value)} />
        <NumberField label="Low zone ends" value={zones.lowZoneEnd} min={min} max={max} step="any" onChange={value => setProperty('lowZoneEnd', value)} />
        <NumberField label="High zone starts" value={zones.highZoneStart} min={min} max={max} step="any" onChange={value => setProperty('highZoneStart', value)} />
        <NumberField label="Tick intervals" value={properties.tickCount ?? 10} min={4} max={12} onChange={value => setProperty('tickCount', value)} />
        <NumberField label="Decimals" value={properties.decimals ?? 1} min={0} max={8} onChange={value => setProperty('decimals', value)} />
        <NumberField label="Scale" value={properties.scale ?? 1} step="0.1" onChange={value => setProperty('scale', value)} />
        <NumberField label="Offset" value={properties.offset ?? 0} step="0.1" onChange={value => setProperty('offset', value)} />
      </div>
      <div className="sb-form-grid">
        <label>Unit source<select value={inheritedUnit ? 'inherit' : 'custom'} onChange={event => setProperties(event.target.value === 'inherit' ? { unitMode: 'inherit' } : { unitMode: 'custom', suffix: properties.suffix || engineering.unit })}><option value="inherit">Inherit from Tag</option><option value="custom">Custom unit</option></select></label>
        {inheritedUnit
          ? <label>Engineering unit<input value={engineering.unit} placeholder="No unit configured" readOnly /></label>
          : <label>Custom unit<input value={properties.suffix || ''} placeholder="°C, bar, rpm" maxLength={40} onChange={event => setProperty('suffix', event.target.value)} /></label>}
        <label>Fallback<input value={properties.fallback ?? '--'} onChange={event => setProperty('fallback', event.target.value)} /></label>
      </div>
      <div className="sb-form-grid">
        <ColorField label="Low zone" value={properties.lowColor || '#38bdf8'} onChange={value => setProperty('lowColor', value)} />
        <ColorField label="Normal zone" value={properties.normalColor || '#a9bec7'} onChange={value => setProperty('normalColor', value)} />
        <ColorField label="High zone" value={properties.highColor || '#fb7185'} onChange={value => setProperty('highColor', value)} />
        <ColorField label="Needle" value={properties.needleColor || '#ff4b1f'} onChange={value => setProperty('needleColor', value)} />
        <ColorField label="Gauge face" value={properties.faceColor || '#d8e4e8'} onChange={value => setProperty('faceColor', value)} />
        <ColorField label="Gauge text" value={properties.textColor || '#263b45'} onChange={value => setProperty('textColor', value)} />
      </div>
      <label className="sb-check"><input type="checkbox" checked={properties.showDigital !== false} onChange={event => setProperty('showDigital', event.target.checked)} /> Show digital readout</label>
    </InspectorGroup>
  )
}

function ButtonProperties({ component, tags, setProperty }) {
  const properties = component.properties || {}
  return <InspectorGroup title="Command"><label>Action<select value={properties.action || 'toggle-boolean'} onChange={event => setProperty('action', event.target.value)}><option value="toggle-boolean">Toggle boolean</option><option value="set-value">Set value</option><option value="pulse">Pulse</option></select></label>{properties.action === 'set-value' && <label>Payload<input value={String(properties.payload ?? '')} onChange={event => setProperty('payload', parseMaybeNumber(event.target.value))} /></label>}{properties.action === 'pulse' && <NumberField label="Pulse duration (ms)" value={properties.pulseMs ?? 300} min={50} onChange={value => setProperty('pulseMs', value)} />}<label>RPC method<input value={properties.rpcMethod || ''} placeholder="setValue" onChange={event => setProperty('rpcMethod', event.target.value)} /></label><label>Feedback tag<select value={properties.feedbackTagId || ''} onChange={event => setProperty('feedbackTagId', event.target.value || null)}><option value="">Use two-way RPC</option>{tags.filter(tag => tag.access !== 'write').map(tag => <option value={tag.id} key={tag.id}>{tag.name}</option>)}</select></label>{properties.feedbackTagId && <label>Expected feedback<input value={String(properties.expectedFeedbackValue ?? '')} onChange={event => setProperty('expectedFeedbackValue', parseMaybeBoolean(event.target.value))} /></label>}<NumberField label="Ack timeout (ms)" value={properties.ackTimeoutMs ?? 5000} min={1000} max={30000} onChange={value => setProperty('ackTimeoutMs', value)} /><label>Confirmation<select value={properties.confirmation || 'single'} onChange={event => setProperty('confirmation', event.target.value)}><option value="none">None</option><option value="single">Single confirmation</option></select></label><ColorField label="Button color" value={properties.buttonColor || '#f6b73c'} onChange={value => setProperty('buttonColor', value)} /></InspectorGroup>
}

function TuningProperties({ component, tag, tags, setProperty, setProperties }) {
  const properties = component.properties || {}
  const range = resolveNumericRange(tag, properties, 'write')
  const tagLimits = numericWriteConstraints(tag)
  const inherited = properties.rangeMode === 'inherit'
  const defaultRamp = Math.max(.001, Math.abs(range.max - range.min) * .001)
  const engineering = numericEngineering(tag)
  return (
    <InspectorGroup title="Tuning command">
      <label>Command range<select value={inherited ? 'inherit' : 'custom'} onChange={event => setProperties(event.target.value === 'inherit' ? { rangeMode: 'inherit' } : { rangeMode: 'custom', min: range.min, max: range.max, step: range.step })}><option value="inherit">Inherit Tag limits</option><option value="custom">Custom narrower limits</option></select></label>
      {inherited && <small className="sb-muted">Using Tag command limits {range.min} – {range.max}, step {range.step}.</small>}
      <div className="sb-form-grid">
        <NumberField label="Minimum" value={inherited ? range.min : properties.min ?? range.min} min={inherited ? undefined : tagLimits.min} max={inherited ? undefined : tagLimits.max} disabled={inherited} onChange={value => setProperty('min', value)} />
        <NumberField label="Maximum" value={inherited ? range.max : properties.max ?? range.max} min={inherited ? undefined : tagLimits.min} max={inherited ? undefined : tagLimits.max} disabled={inherited} onChange={value => setProperty('max', value)} />
        <NumberField label="Step" value={inherited ? range.step : properties.step ?? range.step} min={tagLimits.step} step="any" disabled={inherited} onChange={value => setProperty('step', value)} />
        <NumberField label="Decimals" value={properties.decimals ?? engineering.decimals} min={0} max={8} onChange={value => setProperty('decimals', value)} />
        <NumberField label="Simulation ramp / sec" value={properties.simulationRampPerSecond ?? defaultRamp} min={0.001} step="any" onChange={value => setProperty('simulationRampPerSecond', value)} />
        <label>Unit / suffix<input value={properties.suffix || ''} placeholder={engineering.unit || 'Unit'} onChange={event => setProperty('suffix', event.target.value)} /></label>
        <ColorField label="Accent color" value={properties.accentColor || '#20c4d9'} onChange={value => setProperty('accentColor', value)} />
      </div>
      <label>RPC method<input value={properties.rpcMethod || ''} placeholder="setLevel_Air" onChange={event => setProperty('rpcMethod', event.target.value)} /></label>
      <label>Feedback tag<select value={properties.feedbackTagId || ''} onChange={event => setProperty('feedbackTagId', event.target.value || null)}><option value="">Use two-way RPC</option>{tags.filter(item => item.access !== 'write' && item.dataType === 'number').map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <NumberField label="Ack timeout (ms)" value={properties.ackTimeoutMs ?? 5000} min={1000} max={30000} onChange={value => setProperty('ackTimeoutMs', value)} />
      <label>Confirmation<select value={properties.confirmation || 'single'} onChange={event => setProperty('confirmation', event.target.value)}><option value="none">None</option><option value="single">Single confirmation</option></select></label>
    </InspectorGroup>
  )
}

function OperationShifterProperties({ component, components, tags, setProperty }) {
  const properties = component.properties || {}
  const controls = components.filter(item => ['control-button', 'tuning-slider'].includes(item.type))
  const buttons = controls.filter(item => item.type === 'control-button')
  const controlledIds = Array.isArray(properties.controlledComponentIds) ? properties.controlledComponentIds : []
  const supervisedButtons = buttons.filter(item => controlledIds.includes(item.id))
  const sequence = Array.isArray(properties.autoSequence) ? properties.autoSequence : []
  const toggleControlled = componentId => {
    const next = controlledIds.includes(componentId)
      ? controlledIds.filter(id => id !== componentId)
      : [...controlledIds, componentId]
    setProperty('controlledComponentIds', next)
  }
  const updateStep = (stepId, patch) => setProperty('autoSequence', sequence.map(step => step.id === stepId ? { ...step, ...patch } : step))
  const moveStep = (index, direction) => {
    const target = Math.max(0, Math.min(sequence.length - 1, index + direction))
    if (target === index) return
    const next = [...sequence]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    setProperty('autoSequence', next)
  }
  const addStep = () => {
    const target = supervisedButtons[0]
    if (!target || sequence.length >= 32) return
    const id = `seq-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${sequence.length}`}`
    setProperty('autoSequence', [...sequence, { id, componentId: target.id, value: true, delayMs: 1000, enabled: true }])
  }
  return (
    <>
      <InspectorGroup title="Mode colors">
        <p className="sb-muted">Used by the active mode label and selected menu item.</p>
        <div className="sb-form-grid">
          <ColorField label="MANUAL" value={properties.manualColor || '#3b82f6'} onChange={value => setProperty('manualColor', value)} />
          <ColorField label="AUTO" value={properties.autoColor || '#22c55e'} onChange={value => setProperty('autoColor', value)} />
          <ColorField label="RESET" value={properties.resetColor || '#ef4444'} onChange={value => setProperty('resetColor', value)} />
        </div>
      </InspectorGroup>
      <InspectorGroup title="Dark board button">
        <div className="sb-form-grid">
          <ColorField label="Background" value={properties.darkButtonBackground || '#151719'} onChange={value => setProperty('darkButtonBackground', value)} />
          <ColorField label="Text" value={properties.darkButtonText || '#f0f3f4'} onChange={value => setProperty('darkButtonText', value)} />
          <ColorField label="Border" value={properties.darkButtonBorder || '#3d4246'} onChange={value => setProperty('darkButtonBorder', value)} />
        </div>
      </InspectorGroup>
      <InspectorGroup title="Light board button">
        <div className="sb-form-grid">
          <ColorField label="Background" value={properties.lightButtonBackground || '#e9ece9'} onChange={value => setProperty('lightButtonBackground', value)} />
          <ColorField label="Text" value={properties.lightButtonText || '#172229'} onChange={value => setProperty('lightButtonText', value)} />
          <ColorField label="Border" value={properties.lightButtonBorder || '#747f85'} onChange={value => setProperty('lightButtonBorder', value)} />
        </div>
      </InspectorGroup>
      <InspectorGroup title="Operation command">
        <label>RPC method<input value={properties.rpcMethod || ''} placeholder="setOperationMode" onChange={event => setProperty('rpcMethod', event.target.value)} /></label>
        <label>Mode feedback tag<select value={properties.feedbackTagId || ''} onChange={event => setProperty('feedbackTagId', event.target.value || null)}><option value="">Use two-way RPC</option>{tags.filter(tag => tag.access !== 'write' && ['string', 'enum'].includes(tag.dataType)).map(tag => <option value={tag.id} key={tag.id}>{tag.name}</option>)}</select></label>
        <NumberField label="Ack timeout (ms)" value={properties.ackTimeoutMs ?? 8000} min={1000} max={30000} onChange={value => setProperty('ackTimeoutMs', value)} />
        <label>Confirmation<select value={properties.confirmation || 'single'} onChange={event => setProperty('confirmation', event.target.value)}><option value="none">None</option><option value="single">Confirm mode changes</option></select></label>
      </InspectorGroup>
      <InspectorGroup title="Supervised controls">
        <p className="sb-muted">MANUAL enables these controls. AUTO and RESET interlock them.</p>
        <div className="sb-operation-control-list">
          {controls.map(control => {
            const usedBySequence = sequence.some(step => step.componentId === control.id)
            return <label className="sb-check" key={control.id}><input type="checkbox" checked={controlledIds.includes(control.id)} disabled={usedBySequence} title={usedBySequence ? 'Remove this control from the AUTO sequence first.' : ''} onChange={() => toggleControlled(control.id)} /> {control.name}</label>
          })}
          {!controls.length && <p className="sb-muted">Add Button or Slider components first.</p>}
        </div>
      </InspectorGroup>
      <InspectorGroup title="Auto sequence recipe">
        <p className="sb-muted">SIMULATION runs this recipe through the isolated simulation-sequence route. REAL PLC sends the complete recipe to Node-RED/PLC; browser timing is never used for real equipment.</p>
        <div className="sb-operation-sequence-list">
          {sequence.map((step, index) => (
            <div className="sb-operation-sequence-step" key={step.id}>
              <div className="sb-operation-sequence-head">
                <strong>STEP {index + 1}</strong>
                <label className="sb-check"><input type="checkbox" checked={step.enabled !== false} onChange={event => updateStep(step.id, { enabled: event.target.checked })} /> Use step</label>
              </div>
              <label className="sb-operation-sequence-target">
                Control button
                <select aria-label={`Sequence step ${index + 1} control`} value={step.componentId || ''} onChange={event => updateStep(step.id, { componentId: event.target.value })}>{supervisedButtons.map(button => <option value={button.id} key={button.id}>{button.name}</option>)}</select>
              </label>
              <div className="sb-operation-sequence-fields">
                <label>
                  Output state
                  <select aria-label={`Sequence step ${index + 1} value`} value={step.value === false ? 'off' : 'on'} onChange={event => updateStep(step.id, { value: event.target.value === 'on' })}><option value="on">ACTIVE</option><option value="off">INACTIVE</option></select>
                </label>
                <label>
                  Delay (ms)
                  <input aria-label={`Sequence step ${index + 1} delay`} type="number" min="0" max="3600000" step="100" value={step.delayMs ?? 0} onChange={event => updateStep(step.id, { delayMs: Number(event.target.value) })} />
                </label>
              </div>
              <div className="sb-operation-sequence-actions">
                <button type="button" disabled={index === 0} aria-label={`Move step ${index + 1} up`} onClick={() => moveStep(index, -1)}>↑ Up</button>
                <button type="button" disabled={index === sequence.length - 1} aria-label={`Move step ${index + 1} down`} onClick={() => moveStep(index, 1)}>↓ Down</button>
                <button type="button" className="danger" aria-label={`Remove step ${index + 1}`} onClick={() => setProperty('autoSequence', sequence.filter(item => item.id !== step.id))}>× Remove</button>
              </div>
            </div>
          ))}
          {!sequence.length && <p className="sb-muted">No automatic steps configured.</p>}
        </div>
        <button type="button" onClick={addStep} disabled={!supervisedButtons.length || sequence.length >= 32}>+ Add sequence step</button>
      </InspectorGroup>
    </>
  )
}

function TextProperties({ component, setProperty }) {
  const properties = component.properties || {}
  return <InspectorGroup title="Text appearance"><label>Text<textarea rows="3" value={properties.text ?? ''} placeholder="Type text…" onChange={event => setProperty('text', event.target.value)} /></label><div className="sb-form-grid"><ColorField label="Text color" value={properties.textColor || '#dce8ef'} onChange={value => setProperty('textColor', value)} /><NumberField label="Font size" value={properties.fontSize ?? 32} min={6} max={300} onChange={value => setProperty('fontSize', value)} /><label>Weight<select value={properties.fontWeight ?? 700} onChange={event => setProperty('fontWeight', Number(event.target.value))}><option value="400">Regular</option><option value="600">Semi bold</option><option value="700">Bold</option><option value="900">Black</option></select></label><label>Style<select value={properties.fontStyle || 'normal'} onChange={event => setProperty('fontStyle', event.target.value)}><option value="normal">Normal</option><option value="italic">Italic</option></select></label><label>Font<select value={properties.fontFamily || 'sans-serif'} onChange={event => setProperty('fontFamily', event.target.value)}><option value="sans-serif">Sans serif</option><option value="serif">Serif</option><option value="monospace">Monospace</option></select></label><label>Alignment<select value={properties.textAlign || 'left'} onChange={event => setProperty('textAlign', event.target.value)}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label><label>Vertical<select value={properties.verticalAlign || 'middle'} onChange={event => setProperty('verticalAlign', event.target.value)}><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></select></label></div><label className="sb-check"><input type="checkbox" checked={properties.transparentBackground !== false} onChange={event => setProperty('transparentBackground', event.target.checked)} /> Transparent background</label>{properties.transparentBackground === false && <ColorField label="Background color" value={properties.backgroundColor || '#101418'} onChange={value => setProperty('backgroundColor', value)} />}</InspectorGroup>
}

export function MockControls({ tags, values, onChange, message }) {
  return <div className="sb-mock-controls"><strong>Mock simulation</strong>{tags.map(tag => <label key={tag.id}><span>{tag.name}</span><MockValueInput tag={tag} value={values[tag.id]} onChange={value => onChange(previous => ({ ...previous, [tag.id]: value }))} /></label>)}{message && <em>{message}</em>}</div>
}

function MockValueInput({ tag, value, onChange, compact = false }) {
  if (tag.dataType === 'boolean') return <input aria-label={`${tag.name} mock value`} type="checkbox" checked={Boolean(value)} onChange={event => onChange(event.target.checked)} />
  if (tag.dataType === 'number') return <input aria-label={`${tag.name} mock value`} className={compact ? 'compact' : ''} type="number" value={Number.isFinite(Number(value)) ? value : 0} onChange={event => onChange(Number(event.target.value))} />
  return <input aria-label={`${tag.name} mock value`} className={compact ? 'compact' : ''} value={value ?? ''} onChange={event => onChange(event.target.value)} />
}

function NumberField({ label, value, onChange, min, max, step = 1, allowEmpty = false, disabled = false }) {
  return <label>{label}<input type="number" min={min} max={max} step={step} value={value} disabled={disabled} onChange={event => onChange(allowEmpty && event.target.value === '' ? null : Number(event.target.value))} /></label>
}
function ColorField({ label, value, onChange }) { return <label>{label}<input type="color" value={value} onChange={event => onChange(event.target.value)} /></label> }
function sourceOptionLabel(source) {
  if (source.type === 'mock') return 'Mock'
  const suffix = String(source.id || '').slice(-6)
  if (source.type === 'thingsboard') return `TB · ${suffix}`
  return `${source.type || 'Source'} · ${suffix}`
}
function slugPart(value) { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) }
function parseMaybeNumber(value) { const number = Number(value); return value !== '' && Number.isFinite(number) ? number : value }
function parseMaybeBoolean(value) { return value === 'true' ? true : value === 'false' ? false : parseMaybeNumber(value) }
