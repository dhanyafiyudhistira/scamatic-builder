import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { connectorSourceUsage, detachUnusedConnectorSources } from '../../shared/connector-lifecycle.js'
import { applyNodeRedImportPlan, createNodeRedImportPlan, NODE_RED_IMPORT_LIMITS, parseNodeRedFlow } from '../../shared/node-red-import.js'
import { validateProjectSchema } from '../../shared/project-schema.js'
import { apiRequest } from './api.js'

export function ConnectorManager({ projectId, schema, onSchemaChange, canConfigure, canRotateSecret, draftDirty = false, onNotice }) {
  const [connectors, setConnectors] = useState([])
  const [busy, setBusy] = useState(false)
  const [formExpanded, setFormExpanded] = useState(false)
  const [form, setForm] = useState({ name: '', serverUrl: '', deviceId: '', jwt: '', deviceToken: '', rpcMode: 'feedback-tag' })
  const [accountConnectorId, setAccountConnectorId] = useState(null)
  const [infoConnectorId, setInfoConnectorId] = useState(null)
  const [accountForm, setAccountForm] = useState({ username: '', password: '' })
  const load = useCallback(async () => {
    try { const data = await apiRequest(`/api/connectors?projectId=${encodeURIComponent(projectId)}&environmentRef=staging`); setConnectors(data.connectors || []) }
    catch (error) { onNotice({ type: 'error', text: error.message }) }
  }, [onNotice, projectId])
  useEffect(() => { load() }, [load])

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
    if (!window.confirm(`Delete connector “${connector.name}”? This also removes its encrypted secret and health history.`)) return
    setBusy(true)
    try {
      await apiRequest(`/api/connectors?projectId=${encodeURIComponent(projectId)}&connectorId=${encodeURIComponent(connector.id)}`, { method: 'DELETE' })
      await load()
      onNotice({ type: 'success', text: 'Connector deleted.' })
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

  if (!canConfigure) return <p className="sb-muted">Connector configuration requires source.configure.</p>
  return (
    <div className="sb-connector-manager">
      <div className="sb-connector-list">
        {connectors.map(connector => {
          const usage = connectorSourceUsage(schema, connector.id)
          const attached = usage.attached
          const health = connector.environment?.health?.state || 'unconfigured'
          const commandHealth = connector.environment?.commandHealth?.state || 'unknown'
          const commandHealthLabel = commandHealth === 'unverified' ? 'unverified/timeout' : commandHealth
          const authentication = connector.environment?.authentication || { mode: 'unconfigured', state: 'unconfigured' }
          const autoRefresh = authentication.mode === 'refresh-token'
          const infoOpen = infoConnectorId === connector.id
          const infoPanelId = `connector-info-${String(connector.id).replace(/[^a-zA-Z0-9_-]/g, '')}`
          const deleteDisabled = busy || attached || connector.enabled || draftDirty
          const deleteTitle = attached ? 'Detach and save the draft first.' : connector.enabled ? 'Disable the connector first.' : draftDirty ? 'Save the draft first.' : 'Delete connector'
          return (
            <article className="sb-connector-card" key={connector.id}>
              <header className="sb-connector-card-header">
                <strong>{connector.name}</strong>
                <div className="sb-connector-card-head-actions">
                  <span className={`state-${health}`}>{health}</span>
                  <button type="button" className="sb-connector-info-trigger" aria-label={`${infoOpen ? 'Hide' : 'Show'} connection information for ${connector.name}`} aria-expanded={infoOpen} aria-controls={infoPanelId} title="Connection information" onClick={() => setInfoConnectorId(current => current === connector.id ? null : connector.id)} />
                </div>
              </header>
              <small className="sb-connector-card-summary">ThingsBoard · staging{attached && usage.tagCount ? ` · ${usage.tagCount} tag${usage.tagCount === 1 ? '' : 's'}` : ''}</small>
              {infoOpen && <section id={infoPanelId} className="sb-connector-info-panel" aria-label={`Connection information for ${connector.name}`}>
                <dl>
                  <div className="is-wide"><dt>Endpoint</dt><dd><code title={connector.environment?.config?.serverUrl || 'No endpoint'}>{connector.environment?.config?.serverUrl || 'No endpoint'}</code></dd></div>
                  <div><dt>Environment</dt><dd>staging</dd></div>
                  <div><dt>Source</dt><dd>{attached ? `Attached · ${usage.tagCount} tag${usage.tagCount === 1 ? '' : 's'}` : 'Not attached'}</dd></div>
                  <div className="is-wide"><dt>Credentials</dt><dd>JWT {connector.environment?.secret?.configured ? 'configured' : 'missing'} · Device token {connector.environment?.simulationSecret?.configured ? 'configured' : 'missing'}</dd></div>
                  <div className="is-wide"><dt>JWT auto-refresh</dt><dd><b className={`state-text-${authentication.state}`}>{autoRefresh ? authentication.state : 'off'}</b>{autoRefresh && authentication.accessTokenExpiresAt ? ` · ${tokenExpiryLabel(authentication.accessTokenExpiresAt)}` : ''}</dd></div>
                  <div className="is-wide"><dt>RPC acknowledgment</dt><dd><b className={`state-text-${commandHealth}`}>{commandHealthLabel}</b></dd></div>
                </dl>
                {authentication.message && <p>{authentication.message}</p>}
              </section>}
              <div className="sb-connector-card-actions">
                {attached
                  ? <button type="button" onClick={() => detach(connector)} disabled={busy || usage.tagCount > 0} title={usage.tagCount ? 'Move or delete tags using this source first.' : 'Detach source from draft'}>Detach source</button>
                  : <button type="button" onClick={() => attach(connector)} disabled={busy}>Attach source</button>}
                <button type="button" onClick={() => action(connector, 'test')} disabled={busy || !connector.environment?.secret?.configured}>Test</button>
                {canRotateSecret && <button type="button" className={autoRefresh ? 'sb-connector-auth-active' : ''} onClick={() => toggleAccountConnection(connector)} disabled={busy}>{autoRefresh ? 'Manage ThingsBoard account' : 'Connect ThingsBoard'}</button>}
                {canRotateSecret && <button type="button" onClick={() => configureSimulationToken(connector)} disabled={busy}>Simulation token</button>}
                <div className="sb-connector-lifecycle-actions">
                  <button type="button" onClick={() => action(connector, 'enable')} disabled={busy}>{connector.enabled ? 'Disable' : 'Enable'}</button>
                  <button type="button" className="sb-connector-delete" title={deleteTitle} onClick={() => remove(connector)} disabled={deleteDisabled}>Delete</button>
                </div>
              </div>
              {accountConnectorId === connector.id && <form className="sb-connector-auth-panel" onSubmit={event => connectAccount(event, connector)}>
                <div className="sb-connector-auth-heading"><strong>{autoRefresh ? 'Reconnect ThingsBoard account' : 'Connect ThingsBoard account'}</strong><small>Builder exchanges these credentials once and stores only the encrypted token pair.</small></div>
                <label><span>ThingsBoard email</span><input type="email" value={accountForm.username} onChange={event => setAccountForm(previous => ({ ...previous, username: event.target.value }))} autoComplete="username" required autoFocus /></label>
                <label><span>Password</span><input type="password" value={accountForm.password} onChange={event => setAccountForm(previous => ({ ...previous, password: event.target.value }))} autoComplete="current-password" required /></label>
                <div className="sb-connector-auth-actions"><button type="button" onClick={() => setAccountConnectorId(null)} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect & enable auto-refresh'}</button></div>
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
            <ConnectorField label="Device UUID" helper="ThingsBoard device">
              <input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.deviceId} onChange={event => setForm(previous => ({ ...previous, deviceId: event.target.value }))} required />
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
    </div>
  )
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
