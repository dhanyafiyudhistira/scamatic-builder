import { RUNTIME_ENGINES, runtimeEngineMetadata } from '../../shared/runtime-engine.js'

export function RuntimeEngineSelector({ value, onChange, disabled = false }) {
  const selected = runtimeEngineMetadata(value)
  const isaacPreferred = selected.id === 'isaac'
  return (
    <div className={`sb-profile-selector sb-engine-selector engine-${selected.id}`}>
      <label htmlFor="runtime-engine-select">
        <span>Runtime engine</span>
        <select
          id="runtime-engine-select"
          aria-describedby="runtime-engine-description runtime-engine-status"
          value={selected.id}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
        >
          {RUNTIME_ENGINES.map(engineId => {
            const engine = runtimeEngineMetadata(engineId)
            return <option key={engine.id} value={engine.id}>{engine.label}</option>
          })}
        </select>
      </label>
      <small id="runtime-engine-description">{selected.description}</small>
      <small id="runtime-engine-status" className={isaacPreferred ? 'sb-engine-fallback' : ''}>
        {isaacPreferred
          ? 'Preference saved here. A workspace administrator approves operational rollout from Settings → Isaac runtime setup.'
          : 'Active and backward-compatible for every existing project and runtime session.'}
      </small>
    </div>
  )
}
