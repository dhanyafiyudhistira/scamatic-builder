import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { connectorDeletionBlock, connectorSourceUsage, detachUnusedConnectorSources } from '../../shared/connector-lifecycle.js'
import { applyNodeRedImportPlan, createNodeRedImportPlan, NODE_RED_IMPORT_LIMITS, parseNodeRedFlow } from '../../shared/node-red-import.js'
import { validateProjectSchema } from '../../shared/project-schema.js'
import { apiRequest } from './api.js'
import { InfoPopover, InfoPopoverIntro, InfoPopoverSection } from './InfoPopover.jsx'
import { applyDiscoveredThingsBoardTags } from '../../shared/thingsboard-discovery.js'

export function ConnectorManager({ projectId, schema, onSchemaChange, canConfigure, canRotateSecret, draftDirty = false, directThingsBoard = false, onNotice }) {
  const [connectors, setConnectors] = useState([])
  const [busy, setBusy] = useState(false)
  const [formExpanded, setFormExpanded] = useState(false)
  const [form, setForm] = useState({ name: '', serverUrl: '', deviceId: '', jwt: '', deviceToken: '', rpcMode: 'feedback-tag' })
  const [accountConnectorId, setAccountConnectorId] = useState(null)
  const [accountForm, setAccountForm] = useState({ username: '', password: '' })
  const [deviceBrowser, setDeviceBrowser] = useState(null)
  const load = useCallback(async ({ notify = true } = {}) => {
    try { const data = await apiRequest(`/api/connectors?projectId=${encodeURIComponent(projectId)}&environmentRef=staging`); setConnectors(data.connectors || []) }
    catch (error) { if (notify) onNotice({ type: 'error', text: error.message }) }
  }, [onNotice, projectId])
  useEffect(() => {
    let refreshing = false
    const refresh = async (notify = false) => {
      if (refreshing || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
      refreshing = true
      try { await load({ notify }) } finally { refreshing = false }
    }
    const refreshVisible = () => { void refresh(false) }
    void refresh(true)
    const timer = window.setInterval(refreshVisible, 15_000)
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [load])

  const create = async event => {
    event.preventDefault(); setBusy(true)
    try {
      const created = await apiRequest('/api/connectors', { method: 'POST', body: JSON.stringify({ projectId, name: form.name, type: 'thingsboard', environmentRef: 'staging', config: { serverUrl: form.serverUrl, deviceId: form.deviceId, rpcMode: form.rpcMode } }) })
      let connector = created.connector
      if ((form.jwt || form.deviceToken) && canRotateSecret) {
        const secret = {
          ...(form.jwt ? { jwt: form.jwt } : {}),
          ...(form.deviceToken ? { deviceToken: form.deviceToken } : {}),
        }
        const rotated = await apiRequest('/api/connectors', { method: 'POST', body: JSON.stringify({ action: 'rotate-secret', projectId, connectorId: connector.id, environmentRef: 'staging', secret }) })
        connector = rotated.connector
      }
      attach(connector)
      setForm({ name: '', serverUrl: '', deviceId: '', jwt: '', deviceToken: '', rpcMode: 'feedback-tag' })
      setFormExpanded(false)
      onNotice({ type: 'success', text: 'ThingsBoard connector created. Save the draft to persist its source reference.' })
      await load()
    } catch (error) { onNotice({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  const attach = connector => {
    if (schema.dataSources.some(source => source.connectorRef === connector.id)) return
    const suffix = connector.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)
    onSchemaChange(previous => ({ ...previous, dataSources: [...previous.dataSources, { id: `source_tb_${suffix}`, type: 'thingsboard', environmentRef: 'staging', connectorRef: connector.id }] }))
  }

  const detach = connector => {
    const result = detachUnusedConnectorSources(schema, connector.id)
    if (!result.ok) {
      onNotice({ type: 'error', text: `Move or delete the ${result.usage.tagCount} tag${result.usage.tagCount === 1 ? '' : 's'} using this source before detaching it.` })
      return
    }
    onSchemaChange(previous => detachUnusedConnectorSources(previous, connector.id).schema)
    onNotice({ type: 'success', text: 'Connector source detached. Save the draft before deleting the connector.' })
  }

  const remove = async connector => {
    if (!window.confirm(`Delete connector “${connector.name}”? This removes its encrypted secret and health history. Published snapshots remain immutable, but this connector will no longer be available to them.`)) return
    setBusy(true)
    try {
      await apiRequest(`/api/connectors?projectId=${encodeURIComponent(projectId)}&connectorId=${encodeURIComponent(connector.id)}`, { method: 'DELETE' })
      await load()
      onNotice({ type: 'success', text: 'Connector and encrypted credentials deleted. Published history was preserved.' })
    } catch (error) { onNotice({ type: 'error', text: error.message }); await load() } finally { setBusy(false) }
  }

  const action = async (connector, actionName) => {
    setBusy(true)
    try {
      if (actionName === 'enable') {
        await apiRequest('/api/connectors', { method: 'PUT', body: JSON.stringify({ projectId, connectorId: connector.id, environmentRef: 'staging', name: connector.name, enabled: !connector.enabled, config: connector.environment.config }) })
      } else {
        await apiRequest('/api/connectors', { method: 'POST', body: JSON.stringify({ projectId, connectorId: connector.id, environmentRef: 'staging', action: 'test' }) })
      }
      await load()
      onNotice({ type: 'success', text: actionName === 'enable' ? 'Connector lifecycle updated.' : 'Connection test completed.' })
    } catch (error) { onNotice({ type: 'error', text: error.message }); await load() } finally { setBusy(false) }
  }

  const configureSimulationToken = async connector => {
    const deviceToken = window.prompt('Paste the ThingsBoard device access token for Simulation Bridge. It will be encrypted and never returned to the browser.')
    if (deviceToken == null) return
    setBusy(true)
    try {
      await apiRequest('/api/connectors', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          connectorId: connector.id,
          environmentRef: 'staging',
          action: 'rotate-secret',
          secret: { deviceToken },
        }),
      })
      await load()
      onNotice({ type: 'success', text: 'Simulation device token encrypted. Published Simulation runtimes can now emulate this ThingsBoard device.' })
    } catch (error) {
      onNotice({ type: 'error', text: error.message })
    } finally {
      setBusy(false)
    }
  }

  const toggleAccountConnection = connector => {
    setAccountConnectorId(current => current === connector.id ? null : connector.id)
    setAccountForm({ username: '', password: '' })
  }

  const connectAccount = async (event, connector) => {
    event.preventDefault()
    setBusy(true)
    try {
      await apiRequest('/api/connectors', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          connectorId: connector.id,
          environmentRef: 'staging',
          action: 'connect-account',
          username: accountForm.username,
          password: accountForm.password,
        }),
      })
      setAccountConnectorId(null)
      setAccountForm({ username: '', password: '' })
      await load()
      onNotice({ type: 'success', text: 'ThingsBoard connected. JWT auto-refresh is now active.' })
    } catch (error) {
      onNotice({ type: 'error', text: error.message })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const browseDevices = async (connector, { page = 0, textSearch = '' } = {}) => {
    setDeviceBrowser(previous => ({
      connectorId: connector.id,
      connectorName: connector.name,
      textSearch,
      page,
      devices: previous?.connectorId === connector.id ? previous.devices || [] : [],
      totalElements: previous?.connectorId === connector.id ? previous.totalElements || 0 : 0,
      hasNext: false,
      selectedDevice: previous?.connectorId === connector.id ? previous.selectedDevice || null : null,
      keys: previous?.connectorId === connector.id ? previous.keys || [] : [],
      selectedKeys: previous?.connectorId === connector.id ? previous.selectedKeys || [] : [],
      truncated: previous?.connectorId === connector.id ? Boolean(previous.truncated) : false,
      loading: true,
      error: '',
    }))
    try {
      const data = await apiRequest('/api/connectors', {
        method: 'POST',
        body: JSON.stringify({ projectId, connectorId: connector.id, environmentRef: 'staging', action: 'browse-devices', page, textSearch }),
      })
      setDeviceBrowser(previous => previous?.connectorId === connector.id ? {
        ...previous,
        devices: data.devices || [],
        page: data.page || 0,
        totalElements: data.totalElements || 0,
        hasNext: Boolean(data.hasNext),
        loading: false,
      } : previous)
    } catch (error) {
      setDeviceBrowser(previous => previous?.connectorId === connector.id ? { ...previous, loading: false, error: error.message } : previous)
    }
  }

  const selectDevice = async (connector, device) => {
    setDeviceBrowser(previous => ({ ...previous, loading: true, error: '', selectedDevice: device, keys: [], selectedKeys: [] }))
    try {
      const selected = await apiRequest('/api/connectors', {
        method: 'POST',
        body: JSON.stringify({ projectId, connectorId: connector.id, environmentRef: 'staging', action: 'select-device', deviceId: device.id }),
      })
      attach(connector)
      const discovery = await apiRequest('/api/connectors', {
        method: 'POST',
        body: JSON.stringify({ projectId, connectorId: connector.id, environmentRef: 'staging', action: 'discover-device-telemetry', deviceId: device.id }),
      })
      const keys = discovery.keys || []
      setDeviceBrowser(previous => previous?.connectorId === connector.id ? {
        ...previous,
        selectedDevice: selected.device || device,
        keys,
        selectedKeys: keys.map(item => item.key),
        truncated: Boolean(discovery.truncated),
        loading: false,
      } : previous)
      await load()
    } catch (error) {
      setDeviceBrowser(previous => previous?.connectorId === connector.id ? { ...previous, loading: false, error: error.message } : previous)
      await load({ notify: false })
    }
  }

  const importDiscoveredTelemetry = connector => {
    const selected = new Set(deviceBrowser?.selectedKeys || [])
    const descriptors = (deviceBrowser?.keys || []).filter(item => selected.has(item.key))
    try {
      const preview = applyDiscoveredThingsBoardTags(schema, { connectorId: connector.id, keys: descriptors })
      onSchemaChange(previous => applyDiscoveredThingsBoardTags(previous, { connectorId: connector.id, keys: descriptors }).schema)
      setDeviceBrowser(null)
      onNotice({ type: 'success', text: `${preview.stats.created} telemetry tag${preview.stats.created === 1 ? '' : 's'} imported${preview.stats.skipped ? `; ${preview.stats.skipped} existing key${preview.stats.skipped === 1 ? '' : 's'} skipped` : ''}. Save the draft to persist the mapping.` })
    } catch (error) {
      setDeviceBrowser(previous => ({ ...previous, error: error.message }))
    }
  }

  if (!canConfigure) return <p className="sb-muted">Connector configuration requires source.configure.</p>
  return (
    <div className="sb-connector-manager">
      {directThingsBoard && <div className="sb-iot-connector-note"><strong>Direct ThingsBoard runtime</strong><span>Telemetry, alarms, and RPC use the managed ThingsBoard connector. No Node-RED flow is required.</span></div>}
      <div className="sb-connector-list">
        {connectors.map(connector => {
          const usage = connectorSourceUsage(schema, connector.id)
          const attached = usage.attached
          const health = connector.environment?.health?.state || 'unconfigured'
          const commandHealth = connector.environment?.commandHealth?.state || 'unknown'
          const commandHealthLabel = commandHealth === 'unverified' ? 'unverified/timeout' : commandHealth
          const authentication = connector.environment?.authentication || { mode: 'unconfigured', state: 'unconfigured' }
          const autoRefresh = authentication.mode === 'refresh-token'
          const deletionBlock = connectorDeletionBlock({ enabled: connector.enabled, draftAttached: attached, draftDirty })
          const deleteDisabled = busy || Boolean(deletionBlock)
          const deleteTitle = deletionBlock?.message || 'Delete connector and encrypted credentials'
          return (
            <article className="sb-connector-card" key={connector.id}>
              <header className="sb-connector-card-header">
                <strong>{connector.name}</strong>
                <div className="sb-connector-card-head-actions">
                  <span className={`sb-connector-health state-${health}`}>{health}</span>
                  <InfoPopover className="sb-connector-info" label={`Connection information for ${connector.name}`} title="Connection information" align="end">
                    <InfoPopoverIntro>{connector.name} connection status and protected credential readiness.</InfoPopoverIntro>
                    <InfoPopoverSection title="CONNECTION">
                      <dl>
                        <div className="is-wide"><dt>Endpoint</dt><dd><code title={connector.environment?.config?.serverUrl || 'No endpoint'}>{connector.environment?.config?.serverUrl || 'No endpoint'}</code></dd></div>
                        <div><dt>Environment</dt><dd>staging</dd></div>
                        <div><dt>Source</dt><dd>{attached ? `Attached · ${usage.tagCount} tag${usage.tagCount === 1 ? '' : 's'}` : 'Not attached'}</dd></div>
                      </dl>
                    </InfoPopoverSection>
                    <InfoPopoverSection title="CREDENTIALS">
                      JWT {connector.environment?.secret?.configured ? 'configured' : 'missing'} · Device token {connector.environment?.simulationSecret?.configured ? 'configured' : 'missing'}
                    </InfoPopoverSection>
                    <InfoPopoverSection title="RUNTIME HEALTH">
                      <dl>
                        <div className="is-wide"><dt>JWT auto-refresh</dt><dd><b className={`state-text-${authentication.state}`}>{autoRefresh ? authentication.state : 'off'}</b>{autoRefresh && authentication.accessTokenExpiresAt ? ` · ${tokenExpiryLabel(authentication.accessTokenExpiresAt)}` : ''}</dd></div>
                        <div className="is-wide"><dt>RPC acknowledgment</dt><dd><b className={`state-text-${commandHealth}`}>{commandHealthLabel}</b></dd></div>
                      </dl>
                      {authentication.message && <p>{authentication.message}</p>}
                    </InfoPopoverSection>
                  </InfoPopover>
                </div>
              </header>
              <small className="sb-connector-card-summary">ThingsBoard · staging{attached && usage.tagCount ? ` · ${usage.tagCount} tag${usage.tagCount === 1 ? '' : 's'}` : ''}</small>
              <div className="sb-connector-card-actions">
                {attached
                  ? <button type="button" onClick={() => detach(connector)} disabled={busy || usage.tagCount > 0} title={usage.tagCount ? 'Move or delete tags using this source first.' : 'Detach source from draft'}>Detach source</button>
                  : <button type="button" onClick={() => attach(connector)} disabled={busy}>Attach source</button>}
                <button type="button" onClick={() => action(connector, 'test')} disabled={busy || !connector.environment?.secret?.configured}>Test</button>
                {directThingsBoard && <button type="button" onClick={() => browseDevices(connector)} disabled={busy || !connector.environment?.secret?.configured}>Browse devices</button>}
                {canRotateSecret && <button type="button" onClick={() => toggleAccountConnection(connector)} disabled={busy}>{autoRefresh ? 'Manage ThingsBoard account' : 'Connect ThingsBoard'}</button>}
                {canRotateSecret && <button type="button" onClick={() => configureSimulationToken(connector)} disabled={busy}>Simulation token</button>}
                <div className="sb-connector-lifecycle-actions">
                  <button type="button" onClick={() => action(connector, 'enable')} disabled={busy || (!connector.enabled && !connector.environment?.config?.deviceId)} title={!connector.enabled && !connector.environment?.config?.deviceId ? 'Select a ThingsBoard device first.' : ''}>{connector.enabled ? 'Disable' : 'Enable'}</button>
                  <button type="button" className="sb-connector-delete" title={deleteTitle} onClick={() => remove(connector)} disabled={deleteDisabled}>Delete</button>
                </div>
              </div>
              {accountConnectorId === connector.id && <form className="sb-connector-auth-panel" onSubmit={event => connectAccount(event, connector)}>
                <div className="sb-connector-auth-heading"><strong>{autoRefresh ? 'Reconnect ThingsBoard account' : 'Connect ThingsBoard account'}</strong><small>Builder exchanges these credentials once and stores only the encrypted token pair.</small></div>
                <label><span>ThingsBoard email</span><input type="email" value={accountForm.username} onChange={event => setAccountForm(previous => ({ ...previous, username: event.target.value }))} autoComplete="username" required autoFocus /></label>
                <label><span>Password</span><input type="password" value={accountForm.password} onChange={event => setAccountForm(previous => ({ ...previous, password: event.target.value }))} autoComplete="current-password" required /></label>
                <div className="sb-connector-auth-actions"><button type="button" onClick={() => setAccountConnectorId(null)} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Connecting…' : autoRefresh ? 'Reconnect' : 'Connect'}</button></div>
              </form>}
            </article>
          )
        })}
        {!connectors.length && <p className="sb-muted">No project connectors configured.</p>}
      </div>
      <section className={`sb-connector-disclosure ${formExpanded ? 'is-open' : ''}`}>
        <button type="button" className="sb-connector-disclosure-toggle" aria-expanded={formExpanded} aria-controls="sb-thingsboard-connector-form" onClick={() => setFormExpanded(expanded => !expanded)}>
          <span><strong>Add ThingsBoard connection</strong><small>Endpoint, device, acknowledgment, then connect an account</small></span>
          <i aria-hidden="true" />
        </button>
        {formExpanded && <form id="sb-thingsboard-connector-form" className="sb-connector-form" onSubmit={create}>
          <div className="sb-connector-form-grid">
            <ConnectorField label="Connection name" helper="Shown in Builder">
              <input placeholder="e.g. Mixer staging" value={form.name} onChange={event => setForm(previous => ({ ...previous, name: event.target.value }))} required />
            </ConnectorField>
            <ConnectorField label="Server URL" helper="Secure HTTPS endpoint">
              <input type="url" placeholder="https://thingsboard.example.com" value={form.serverUrl} onChange={event => setForm(previous => ({ ...previous, serverUrl: event.target.value }))} required />
            </ConnectorField>
            <ConnectorField label="Device UUID" helper={directThingsBoard ? 'Optional · choose securely after connecting' : 'ThingsBoard device'}>
              <input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.deviceId} onChange={event => setForm(previous => ({ ...previous, deviceId: event.target.value }))} required={!directThingsBoard} />
            </ConnectorField>
            <ConnectorField label="Acknowledgment" helper="Command confirmation">
              <select value={form.rpcMode} onChange={event => setForm(previous => ({ ...previous, rpcMode: event.target.value }))}><option value="feedback-tag">Feedback tag</option><option value="two-way">Two-way RPC</option></select>
            </ConnectorField>
            {canRotateSecret && <ConnectorField label="Access JWT" helper="Optional manual mode · encrypted" wide>
              <input type="password" placeholder="Paste ThingsBoard JWT" autoComplete="new-password" value={form.jwt} onChange={event => setForm(previous => ({ ...previous, jwt: event.target.value }))} />
            </ConnectorField>}
            {canRotateSecret && <ConnectorField label="Device access token" helper="Simulation Bridge · encrypted · write-only" wide>
              <input type="password" placeholder="Paste ThingsBoard device access token" autoComplete="new-password" value={form.deviceToken} onChange={event => setForm(previous => ({ ...previous, deviceToken: event.target.value }))} />
            </ConnectorField>}
          </div>
          <div className="sb-connector-form-footer"><small>Create the connector, then use Connect ThingsBoard to enable automatic JWT refresh. Connector remains disabled until explicitly enabled.</small><button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create connector'}</button></div>
        </form>}
      </section>
      {deviceBrowser && <DeviceBrowserModal
        state={deviceBrowser}
        connector={connectors.find(item => item.id === deviceBrowser.connectorId)}
        onClose={() => setDeviceBrowser(null)}
        onSearch={textSearch => {
          const connector = connectors.find(item => item.id === deviceBrowser.connectorId)
          if (connector) void browseDevices(connector, { page: 0, textSearch })
        }}
        onPage={page => {
          const connector = connectors.find(item => item.id === deviceBrowser.connectorId)
          if (connector) void browseDevices(connector, { page, textSearch: deviceBrowser.textSearch })
        }}
        onSelect={device => {
          const connector = connectors.find(item => item.id === deviceBrowser.connectorId)
          if (connector) void selectDevice(connector, device)
        }}
        onToggleKey={(key, checked) => setDeviceBrowser(previous => ({ ...previous, selectedKeys: checked ? [...new Set([...previous.selectedKeys, key])] : previous.selectedKeys.filter(item => item !== key) }))}
        onToggleAll={checked => setDeviceBrowser(previous => ({ ...previous, selectedKeys: checked ? previous.keys.map(item => item.key) : [] }))}
        onImport={() => {
          const connector = connectors.find(item => item.id === deviceBrowser.connectorId)
          if (connector) importDiscoveredTelemetry(connector)
        }}
      />}
    </div>
  )
}

function DeviceBrowserModal({ state, connector, onClose, onSearch, onPage, onSelect, onToggleKey, onToggleAll, onImport }) {
  const [query, setQuery] = useState(state.textSearch || '')
  const selected = new Set(state.selectedKeys || [])
  useEffect(() => {
    const closeOnEscape = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  return createPortal(
    <div className="sb-modal-backdrop sb-device-browser-backdrop" onMouseDown={onClose}>
      <div className="sb-device-browser-modal" role="dialog" aria-modal="true" aria-labelledby="device-browser-title" onMouseDown={event => event.stopPropagation()}>
        <header className="sb-device-browser-header">
          <div><span className="eyebrow">THINGSBOARD DISCOVERY</span><h2 id="device-browser-title">Device & telemetry browser</h2><p>{state.connectorName} · account JWT remains encrypted server-side</p></div>
          <button type="button" className="sb-flow-import-close" aria-label="Close device browser" onClick={onClose}><span aria-hidden="true" /></button>
        </header>
        <div className="sb-device-browser-grid">
          <section className="sb-device-browser-devices">
            <form onSubmit={event => { event.preventDefault(); onSearch(query.trim()) }}><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search device name…" maxLength={120} /><button type="submit" disabled={state.loading}>Search</button></form>
            <div className="sb-device-browser-list" aria-busy={state.loading}>
              {state.devices.map(device => <button type="button" className={state.selectedDevice?.id === device.id ? 'is-selected' : ''} key={device.id} onClick={() => onSelect(device)} disabled={state.loading || (connector?.enabled && connector.environment?.config?.deviceId !== device.id)} title={connector?.enabled && connector.environment?.config?.deviceId !== device.id ? 'Disable connector before switching device.' : ''}><span><strong>{device.label || device.name}</strong><small>{device.label ? device.name : device.type || 'ThingsBoard device'}</small></span><code>{device.id}</code></button>)}
              {!state.loading && !state.devices.length && <p className="sb-muted">No matching devices.</p>}
            </div>
            <footer><button type="button" onClick={() => onPage(Math.max(0, state.page - 1))} disabled={state.loading || state.page <= 0}>Previous</button><span>Page {state.page + 1} · {state.totalElements} devices</span><button type="button" onClick={() => onPage(state.page + 1)} disabled={state.loading || !state.hasNext}>Next</button></footer>
          </section>
          <section className="sb-device-browser-telemetry">
            <header><div><strong>{state.selectedDevice ? state.selectedDevice.label || state.selectedDevice.name : 'Select a device'}</strong><small>{state.selectedDevice ? `${state.keys.length} latest telemetry keys discovered${state.truncated ? ' · first 100 shown' : ''}` : 'Its telemetry keys and latest samples will appear here.'}</small></div>{state.keys.length > 0 && <label><input type="checkbox" checked={selected.size === state.keys.length} onChange={event => onToggleAll(event.target.checked)} /> All</label>}</header>
            <div className="sb-device-telemetry-list" aria-busy={state.loading}>
              {state.keys.map(item => <label key={item.key}><input type="checkbox" checked={selected.has(item.key)} onChange={event => onToggleKey(item.key, event.target.checked)} /><span><strong>{item.key}</strong><small>{item.dataType} · {telemetrySampleLabel(item.sample)}</small></span></label>)}
              {state.selectedDevice && !state.loading && !state.keys.length && <p className="sb-muted">This device has no timeseries telemetry keys yet.</p>}
            </div>
          </section>
        </div>
        {state.error && <div className="sb-form-error" role="alert">{state.error}</div>}
        <footer className="sb-device-browser-footer"><span>{state.loading ? 'Loading securely from ThingsBoard…' : `${selected.size} telemetry key${selected.size === 1 ? '' : 's'} selected`}</span><div><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" onClick={onImport} disabled={state.loading || !selected.size}>Import tags</button></div></footer>
      </div>
    </div>,
    document.body,
  )
}

function telemetrySampleLabel(value) {
  if (value == null || value === '') return 'no current sample'
  return String(value).slice(0, 80)
}

export function FlowImportModal({ schema, onClose, onApply }) {
  const defaultSourceId = schema.dataSources.find(source => source.type !== 'mock')?.id || schema.dataSources[0]?.id || ''
  const [raw, setRaw] = useState('')
  const [fileName, setFileName] = useState('')
  const [analysis, setAnalysis] = useState(null)
  const [sourceId, setSourceId] = useState(defaultSourceId)
  const [selectedKeys, setSelectedKeys] = useState([])
  const [componentKeys, setComponentKeys] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = event => { if (event.key === 'Escape') onClose() }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', closeOnEscape) }
  }, [onClose])

  const analyze = value => {
    setError('')
    try {
      const result = parseNodeRedFlow(value)
      setAnalysis(result)
      setSelectedKeys(result.candidates.map(candidate => candidate.importKey))
      setComponentKeys(result.candidates.filter(candidate => candidate.componentType).map(candidate => candidate.importKey))
    } catch (analysisError) {
      setAnalysis(null)
      setError(analysisError.message)
    }
  }

  const chooseFile = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > NODE_RED_IMPORT_LIMITS.maxBytes) {
      setError('Flow JSON exceeds the 2 MB import limit.')
      return
    }
    try {
      const value = await file.text()
      setRaw(value)
      setFileName(file.name)
      analyze(value)
    } catch {
      setError('Unable to read the selected JSON file.')
    }
  }

  const planResult = useMemo(() => {
    if (!analysis) return { plan: null, issues: [], error: '' }
    try {
      const plan = createNodeRedImportPlan(analysis, schema, { sourceId, selectedKeys, componentKeys })
      const merged = applyNodeRedImportPlan(schema, plan)
      const baselineIssues = new Set(validateProjectSchema(schema).filter(issue => issue.severity === 'error').map(importIssueKey))
      const issues = validateProjectSchema(merged).filter(issue => issue.severity === 'error' && !baselineIssues.has(importIssueKey(issue)))
      return { plan, issues, error: '' }
    } catch (planError) {
      return { plan: null, issues: [], error: planError.message }
    }
  }, [analysis, componentKeys, schema, selectedKeys, sourceId])

  const toggleKey = (setter, key, checked) => setter(previous => checked ? [...new Set([...previous, key])] : previous.filter(item => item !== key))
  const selected = new Set(selectedKeys)
  const selectedComponents = new Set(componentKeys)
  const canApply = Boolean(planResult.plan && selectedKeys.length && !planResult.issues.length)
  const reset = () => { setAnalysis(null); setRaw(''); setFileName(''); setSelectedKeys([]); setComponentKeys([]); setError('') }

  return createPortal(
    <div className="sb-modal-backdrop sb-flow-import-backdrop" onMouseDown={onClose}>
      <div className="sb-flow-import-modal" role="dialog" aria-modal="true" aria-labelledby="flow-import-title" onMouseDown={event => event.stopPropagation()}>
        <header className="sb-flow-import-header">
          <div><span className="eyebrow">FLOW CONVERSION</span><h2 id="flow-import-title">Import Node-RED JSON</h2><p>{analysis ? `${analysis.flowName} · ${analysis.nodeCount} nodes · ${analysis.fingerprint}` : 'Convert flow variables into Builder tags and ready-to-place components.'}</p></div>
          <button type="button" className="sb-flow-import-close" aria-label="Close flow importer" onClick={onClose}><span aria-hidden="true" /></button>
        </header>

        {!analysis ? <div className="sb-flow-import-input-step">
          <label className="sb-flow-import-file"><input type="file" accept=".json,application/json" onChange={chooseFile} /><span aria-hidden="true">JSON</span><strong>Choose Node-RED flow</strong><small>Parsed locally · maximum 2 MB · credentials are ignored</small></label>
          <div className="sb-flow-import-divider"><span>OR PASTE JSON</span></div>
          <textarea value={raw} onChange={event => { setRaw(event.target.value); setFileName(''); setError('') }} placeholder="Paste the exported Node-RED flow array here…" spellCheck="false" />
          {error && <div className="sb-form-error" role="alert">{error}</div>}
          <div className="sb-flow-import-input-actions"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!raw.trim()} onClick={() => analyze(raw)}>Analyze flow</button></div>
        </div> : <>
          <section className="sb-flow-import-toolbar">
            <div className="sb-flow-import-stats"><span><strong>{analysis.candidates.length}</strong> candidates</span><span><strong>{analysis.stats.telemetryKeys}</strong> telemetry</span><span><strong>{analysis.stats.writableVariables}</strong> writable</span></div>
            <label>Target data source<select value={sourceId} onChange={event => setSourceId(event.target.value)}>{schema.dataSources.map(source => <option key={source.id} value={source.id}>{source.id} · {source.type}</option>)}</select></label>
          </section>

          <section className="sb-flow-import-selection" aria-label="Import mapping preview">
            <header><div><strong>Detected mappings</strong><small>Select tags and their suggested components.</small></div><div><button type="button" onClick={() => setSelectedKeys(analysis.candidates.map(candidate => candidate.importKey))}>All tags</button><button type="button" onClick={() => setComponentKeys(analysis.candidates.filter(candidate => candidate.componentType && selected.has(candidate.importKey)).map(candidate => candidate.importKey))}>All components</button></div></header>
            <div className="sb-flow-import-table-head"><span>Tag</span><span>Type / access</span><span>Suggested component</span></div>
            <div className="sb-flow-import-rows">
              {analysis.candidates.map(candidate => <div className={`sb-flow-import-row ${selected.has(candidate.importKey) ? 'is-selected' : ''}`} key={candidate.importKey}>
                <label className="sb-flow-import-tag-choice"><input type="checkbox" checked={selected.has(candidate.importKey)} onChange={event => { toggleKey(setSelectedKeys, candidate.importKey, event.target.checked); if (!event.target.checked) toggleKey(setComponentKeys, candidate.importKey, false) }} /><span><strong>{candidate.name}</strong><code>{candidate.path}</code></span></label>
                <div className="sb-flow-import-type"><span>{candidate.dataType}</span><span>{candidate.access}</span></div>
                <label className="sb-flow-import-component-choice"><input type="checkbox" disabled={!selected.has(candidate.importKey) || !candidate.componentType} checked={selected.has(candidate.importKey) && selectedComponents.has(candidate.importKey)} onChange={event => toggleKey(setComponentKeys, candidate.importKey, event.target.checked)} /><span><strong>{candidate.componentType ? humanizeComponentType(candidate.componentType) : 'Manual mapping'}</strong>{candidate.rpcMethod && <code>{candidate.rpcMethod}</code>}</span></label>
              </div>)}
            </div>
          </section>

          <section className="sb-flow-import-report">
            <div><strong>{planResult.plan?.stats.tagsCreated || 0}</strong><span>new tags</span></div><div><strong>{planResult.plan?.stats.tagsReused || 0}</strong><span>reused tags</span></div><div><strong>{planResult.plan?.stats.componentsCreated || 0}</strong><span>new components</span></div><div><strong>{planResult.plan?.stats.componentsReused || 0}</strong><span>reused components</span></div>
          </section>
          {(error || planResult.error) && <div className="sb-form-error" role="alert">{error || planResult.error}</div>}
          {planResult.issues.length > 0 && <div className="sb-form-error" role="alert">Import validation found {planResult.issues.length} blocking issue{planResult.issues.length === 1 ? '' : 's'}: {planResult.issues.slice(0, 3).map(issue => issue.message).join(' · ')}</div>}
          <div className="sb-flow-import-warnings"><strong>Review before import</strong><ul>{planResult.plan?.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div>
          <footer className="sb-flow-import-footer"><button type="button" onClick={reset}>Choose another flow</button><span>{fileName || 'Pasted JSON'} · One undoable draft change</span><button type="button" className="primary" disabled={!canApply} onClick={() => onApply(planResult.plan)}>Import selected</button></footer>
        </>}
      </div>
    </div>,
    document.body,
  )
}

function ConnectorField({ label, helper, wide = false, children }) {
  return <label className={`sb-connector-field ${wide ? 'is-wide' : ''}`}><span><strong>{label}</strong><small>{helper}</small></span>{children}</label>
}

function humanizeComponentType(type) {
  return String(type || '').split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function importIssueKey(issue) {
  return `${issue.code || ''}:${issue.path || ''}:${issue.message || ''}`
}

function tokenExpiryLabel(value) {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return 'expiry unknown'
  const remainingMs = timestamp.getTime() - Date.now() - 5 * 60_000
  if (remainingMs <= 0) return timestamp.getTime() <= Date.now() ? 'expired' : 'refresh pending'
  const minutes = Math.max(1, Math.round(remainingMs / 60_000))
  return minutes < 60 ? `refresh in ~${minutes}m` : `refresh in ~${Math.round(minutes / 60)}h`
}
