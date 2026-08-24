export function validationNoticeDetails(issues, limit = 12) {
  if (!Array.isArray(issues) || !issues.length) return []
  const normalized = issues
    .filter(issue => issue && typeof issue === 'object' && issue.message)
    .map(issue => ({
      severity: issue.severity === 'warning' ? 'warning' : 'error',
      message: String(issue.message),
      path: String(issue.path || ''),
    }))
    .sort((left, right) => severityOrder(left.severity) - severityOrder(right.severity))
  const visible = normalized.slice(0, Math.max(1, limit))
  if (normalized.length > visible.length) {
    visible.push({ severity: 'warning', message: `${normalized.length - visible.length} additional validation issue(s) are shown in the Validation panel.`, path: '' })
  }
  return visible
}

function severityOrder(severity) {
  return severity === 'error' ? 0 : 1
}
