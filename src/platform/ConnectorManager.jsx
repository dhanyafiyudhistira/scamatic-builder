import { useCallback, useEffect, useState } from 'react'
import { connectorSourceUsage, detachUnusedConnectorSources } from '../../shared/connector-lifecycle.js'
import { apiRequest } from './api.js'

export function ConnectorManager({ projectId, schema, onSchemaChange, canConfigure, canRotateSecret, draftDirty = false, onNotice }) {
  const [connectors, setConnectors] = useState([])
  const [busy, setBusy] = useState(false)
  const [formExpanded, setFormExpanded] = useState(false)
  const [form, setForm] = useState({ name: '', serverUrl: '', deviceId: '', jwt: '', deviceToken: '', rpcMode: 'feedback-tag' })
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
          const deleteDisabled = busy || attached || connector.enabled || draftDirty
          const deleteTitle = attached ? 'Detach and save the draft first.' : connector.enabled ? 'Disable the connector first.' : draftDirty ? 'Save the draft first.' : 'Delete connector'
          return (
            <article className="sb-connector-card" key={connector.id}>
              <header className="sb-connector-card-header">
                <strong>{connector.name}</strong>
                <span className={`state-${health}`}>{health}</span>
              </header>
              <code title={connector.environment?.config?.serverUrl || 'No endpoint'}>{connector.environment?.config?.serverUrl || 'No endpoint'}</code>
              <small title={`JWT ${connector.environment?.secret?.configured ? 'configured' : 'missing'} · Device token ${connector.environment?.simulationSecret?.configured ? 'configured' : 'missing'} · staging`}>
                JWT {connector.environment?.secret?.configured ? 'configured' : 'missing'} · Device token {connector.environment?.simulationSecret?.configured ? 'configured' : 'missing'} · staging{attached && usage.tagCount ? ` · ${usage.tagCount} tag${usage.tagCount === 1 ? '' : 's'}` : ''}
              </small>
              <small>RPC acknowledgment: <b className={`state-text-${commandHealth}`}>{commandHealthLabel}</b></small>
              <div className="sb-connector-card-actions">
                {attached
                  ? <button type="button" onClick={() => detach(connector)} disabled={busy || usage.tagCount > 0} title={usage.tagCount ? 'Move or delete tags using this source first.' : 'Detach source from draft'}>Detach source</button>
                  : <button type="button" onClick={() => attach(connector)} disabled={busy}>Attach source</button>}
                <button type="button" onClick={() => action(connector, 'test')} disabled={busy || !connector.environment?.secret?.configured}>Test</button>
                {canRotateSecret && <button type="button" onClick={() => configureSimulationToken(connector)} disabled={busy}>Simulation token</button>}
                <div className="sb-connector-lifecycle-actions">
                  <button type="button" onClick={() => action(connector, 'enable')} disabled={busy}>{connector.enabled ? 'Disable' : 'Enable'}</button>
                  <button type="button" className="sb-connector-delete" title={deleteTitle} onClick={() => remove(connector)} disabled={deleteDisabled}>Delete</button>
                </div>
              </div>
            </article>
          )
        })}
        {!connectors.length && <p className="sb-muted">No project connectors configured.</p>}
      </div>
      <section className={`sb-connector-disclosure ${formExpanded ? 'is-open' : ''}`}>
        <button type="button" className="sb-connector-disclosure-toggle" aria-expanded={formExpanded} aria-controls="sb-thingsboard-connector-form" onClick={() => setFormExpanded(expanded => !expanded)}>
          <span><strong>Add ThingsBoard connection</strong><small>Endpoint, device, acknowledgment, and JWT</small></span>
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
            {canRotateSecret && <ConnectorField label="Access JWT" helper="Encrypted · write-only" wide>
              <input type="password" placeholder="Paste ThingsBoard JWT" autoComplete="new-password" value={form.jwt} onChange={event => setForm(previous => ({ ...previous, jwt: event.target.value }))} />
            </ConnectorField>}
            {canRotateSecret && <ConnectorField label="Device access token" helper="Simulation Bridge · encrypted · write-only" wide>
              <input type="password" placeholder="Paste ThingsBoard device access token" autoComplete="new-password" value={form.deviceToken} onChange={event => setForm(previous => ({ ...previous, deviceToken: event.target.value }))} />
            </ConnectorField>}
          </div>
          <div className="sb-connector-form-footer"><small>Connector is created disabled until explicitly enabled.</small><button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create connector'}</button></div>
        </form>}
      </section>
    </div>
  )
}

function ConnectorField({ label, helper, wide = false, children }) {
  return <label className={`sb-connector-field ${wide ? 'is-wide' : ''}`}><span><strong>{label}</strong><small>{helper}</small></span>{children}</label>
}
