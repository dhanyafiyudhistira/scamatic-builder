import { RUNTIME_PROFILES, runtimeProfileMetadata } from '../../shared/runtime-profile.js'

export function RuntimeProfileSelector({ value, onChange }) {
  const selected = runtimeProfileMetadata(value)
  return (
    <div className={`sb-profile-selector profile-${selected.id}`}>
      <label htmlFor="runtime-profile-select">
        <span>Runtime profile</span>
        <select
          id="runtime-profile-select"
          aria-describedby="runtime-profile-description"
          value={selected.id}
          onChange={event => onChange(event.target.value)}
        >
          {RUNTIME_PROFILES.map(profileId => {
            const profile = runtimeProfileMetadata(profileId)
            return <option key={profile.id} value={profile.id}>{profile.label}</option>
          })}
        </select>
      </label>
      <small id="runtime-profile-description">{selected.description}</small>
    </div>
  )
}

export function RuntimeProfileBanner({ profile: input, preview = false }) {
  const profile = input?.id ? input : runtimeProfileMetadata(input)
  return (
    <section className={`sb-runtime-profile-banner profile-${profile.id}`} role="status">
      <strong>{preview ? 'PREVIEW · ' : ''}{profile.label}</strong>
      <span>{profile.description}</span>
    </section>
  )
}
