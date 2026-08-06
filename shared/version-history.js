export function restoredFromVersionNumber(version, versions = []) {
  const direct = Number(version?.restoredFromVersion)
  if (Number.isInteger(direct) && direct > 0) return direct
  if (!version?.restoredFromVersionId) return null

  const source = versions.find(candidate => String(candidate.id) === String(version.restoredFromVersionId))
  const linked = Number(source?.version)
  if (Number.isInteger(linked) && linked > 0) return linked

  const messageMatch = String(version.message || '').match(/\b(?:version\s*)?v?(\d+)\b/i)
  const parsed = Number(messageMatch?.[1])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function describeVersion(version, versions = []) {
  const restoredFrom = restoredFromVersionNumber(version, versions)
  if (version?.restoredFromVersionId || restoredFrom) {
    return {
      kind: 'restore',
      restoredFrom,
      label: restoredFrom ? `Restored from v${restoredFrom}` : 'Restored from an earlier snapshot',
    }
  }
  return {
    kind: 'publish',
    restoredFrom: null,
    label: version?.message || 'Published snapshot',
  }
}

export function nextVersionNumber(versions = []) {
  return versions.reduce((highest, version) => Math.max(highest, Number(version?.version) || 0), 0) + 1
}
