import { useCallback, useEffect, useState } from 'react'
import { apiRequest } from './api.js'

const DEFAULT_FORM = {
  uri: '',
  enabled: true,
  dbName: 'scamatic_telemetry',
  collectionName: 'chart_samples',
  retentionDays: 30,
  batchSize: 500,
  flushMs: 250,
  maxQueue: 20_000,
  maxPoolSize: 20,
  maxBootstrapPoints: 10_000,
}

export function ChartStorageManager({ onNotice }) {
  const [storage, setStorage] = useState(null)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await apiRequest('/api/chart-storage')
      setStorage(data.storage)
      setForm(previous => ({
        ...previous,
        enabled: data.storage?.enabled ?? previous.enabled,
        dbName: data.storage?.dbName || previous.dbName,
        collectionName: data.storage?.collectionName || previous.collectionName,
        retentionDays: data.storage?.retentionDays || previous.retentionDays,
        batchSize: data.storage?.batchSize || previous.batchSize,
        flushMs: data.storage?.flushMs || previous.flushMs,
        maxQueue: data.storage?.maxQueue || previous.maxQueue,
        maxPoolSize: data.storage?.maxPoolSize || previous.maxPoolSize,
        maxBootstrapPoints: data.storage?.maxBootstrapPoints || previous.maxBootstrapPoints,
      }))
    } catch (error) {
      onNotice({ type: 'error', text: error.message })
    }
  }, [onNotice])
  useEffect(() => { load() }, [load])

  const submit = async (action, event) => {
    event?.preventDefault()
    setBusy(true)
    try {
      if (action === 'test') {
        const result = await apiRequest('/api/chart-storage', { method: 'POST', body: JSON.stringify({ action: 'test', ...form }) })
        onNotice({ type: 'success', text: result.message })
      } else {
        const data = await apiRequest('/api/chart-storage', { method: 'PUT', body: JSON.stringify(form) })
        setStorage(data.storage)
        setForm(previous => ({ ...previous, uri: '' }))
        setExpanded(false)
        onNotice({ type: 'success', text: 'Chart storage configuration encrypted and saved.' })
      }
      await load()
    } catch (error) {
      onNotice({ type: 'error', text: error.message })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm('Remove the workspace Chart storage configuration and encrypted URI? Existing telemetry in MongoDB is not deleted.')) return
    setBusy(true)
    try {
      await apiRequest('/api/chart-storage', { method: 'DELETE', body: JSON.stringify({ confirmation: 'REMOVE' }) })
      setStorage(null)
      setForm(DEFAULT_FORM)
      onNotice({ type: 'success', text: 'Chart storage configuration removed. Runtime will use environment fallback or session history.' })
      await load()
    } catch (error) {
      onNotice({ type: 'error', text: error.message })
    } finally {
      setBusy(false)
    }
  }

  const set = (key, value) => setForm(previous => ({ ...previous, [key]: value }))
  const health = storage?.health?.state || 'unconfigured'
  const reusableSecret = storage?.source === 'workspace' && storage?.secretConfigured

  return (
    <div className="sb-chart-storage-manager">
      <div className="sb-chart-storage-status">
        <div>
          <span className={`state-${health}`}>{health}</span>
          <strong>{storage?.targetLabel || 'No workspace archive'}</strong>
        </div>
        <dl>
          <div><dt>Source</dt><dd>{storage?.source || 'disabled'}</dd></div>
          <div><dt>Engine</dt><dd>{storage?.engine || 'session-memory'}</dd></div>
          <div><dt>Retention</dt><dd>{storage?.retentionDays ? `${storage.retentionDays} days` : 'Session only'}</dd></div>
          <div><dt>Secret</dt><dd>{storage?.source === 'environment' ? 'Server managed' : storage?.secretConfigured ? 'Encrypted' : 'Not configured'}</dd></div>
        </dl>
        <p>{storage?.health?.message || 'Configure an isolated MongoDB time-series archive.'}</p>
      </div>

      <section className={`sb-connector-disclosure ${expanded ? 'is-open' : ''}`}>
        <button type="button" className="sb-connector-disclosure-toggle" aria-expanded={expanded} aria-controls="sb-chart-storage-form" onClick={() => setExpanded(value => !value)}>
          <span><strong>Configure MongoDB archive</strong><small>Workspace-isolated · encrypted write-only URI</small></span>
          <i aria-hidden="true" />
        </button>
        {expanded && (
          <form id="sb-chart-storage-form" className="sb-connector-form sb-chart-storage-form" onSubmit={event => submit('save', event)}>
            <div className="sb-connector-form-grid">
              <StorageField label="MongoDB URI" helper={reusableSecret ? 'Write-only · blank keeps current secret' : 'Write-only · required'} wide>
                <input type="password" autoComplete="new-password" placeholder={reusableSecret ? '•••••••• (encrypted secret configured)' : 'mongodb+srv://user:password@cluster/database'} value={form.uri} onChange={event => set('uri', event.target.value)} />
              </StorageField>
              <StorageField label="Database" helper="Telemetry-only database"><input value={form.dbName} onChange={event => set('dbName', event.target.value)} required /></StorageField>
              <StorageField label="Collection" helper="MongoDB time-series"><input value={form.collectionName} onChange={event => set('collectionName', event.target.value)} required /></StorageField>
              <StorageField label="Retention days" helper="MongoDB TTL"><input type="number" min="1" max="3650" value={form.retentionDays} onChange={event => set('retentionDays', Number(event.target.value))} required /></StorageField>
              <StorageField label="Batch size" helper="10–2000 samples"><input type="number" min="10" max="2000" value={form.batchSize} onChange={event => set('batchSize', Number(event.target.value))} required /></StorageField>
              <StorageField label="Flush interval" helper="50–5000 ms"><input type="number" min="50" max="5000" value={form.flushMs} onChange={event => set('flushMs', Number(event.target.value))} required /></StorageField>
              <StorageField label="Maximum queue" helper="Bounded backpressure"><input type="number" min="100" max="200000" value={form.maxQueue} onChange={event => set('maxQueue', Number(event.target.value))} required /></StorageField>
              <StorageField label="Connection pool" helper="2–100 connections"><input type="number" min="2" max="100" value={form.maxPoolSize} onChange={event => set('maxPoolSize', Number(event.target.value))} required /></StorageField>
              <StorageField label="History bootstrap" helper="100–50000 points"><input type="number" min="100" max="50000" value={form.maxBootstrapPoints} onChange={event => set('maxBootstrapPoints', Number(event.target.value))} required /></StorageField>
            </div>
            <label className="sb-check"><input type="checkbox" checked={form.enabled} onChange={event => set('enabled', event.target.checked)} /> Enable persistent Chart archive</label>
            <p className="sb-chart-storage-security">URI credentials are encrypted server-side and never returned to this browser. Production targets must be explicitly allowlisted.</p>
            <div className="sb-connector-form-footer">
              <button type="button" onClick={event => submit('test', event)} disabled={busy || (!form.uri && !reusableSecret)}>Test connection</button>
              <button type="submit" className="primary" disabled={busy || (form.enabled && !form.uri && !reusableSecret)}>{busy ? 'Saving…' : form.enabled ? 'Test & save' : 'Save disabled state'}</button>
            </div>
          </form>
        )}
      </section>
      {storage?.source === 'workspace' && <button type="button" className="danger sb-chart-storage-remove" onClick={remove} disabled={busy}>Remove workspace configuration</button>}
    </div>
  )
}

function StorageField({ label, helper, wide = false, children }) {
  return <label className={`sb-connector-field ${wide ? 'is-wide' : ''}`}><span><strong>{label}</strong><small>{helper}</small></span>{children}</label>
}
