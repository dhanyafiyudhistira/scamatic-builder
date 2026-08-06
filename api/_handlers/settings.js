import { requirePrincipal } from '../_lib/auth.js'
import { connectMongo } from '../_lib/mongo.js'
import { Settings } from '../_lib/models.js'

export default async function handler(req, res) {
  if (req.method === 'GET' && legacySettingsReadEnabled()) {
    await connectMongo()
    const mode = normalizeLegacyMode(req.query?.mode)
    const settings = await Settings.findById(mode).lean()
      || (mode === 'global' ? null : await Settings.findById('global').lean())
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Deprecation', 'true')
    res.setHeader('Sunset', 'Wed, 21 Oct 2026 00:00:00 GMT')
    return res.status(200).json({
      serverUrl: String(settings?.serverUrl || ''),
      deviceId: String(settings?.deviceId || ''),
      token: String(settings?.token || ''),
      deprecated: true,
      readOnly: true,
    })
  }

  const principal = await requirePrincipal(req, res)
  if (!principal) return
  if (!['OWNER', 'ADMIN'].includes(principal.role)) return res.status(403).json({ error: 'Insufficient permission.' })
  res.setHeader('Deprecation', 'true')
  res.setHeader('Sunset', 'Wed, 21 Oct 2026 00:00:00 GMT')
  if (req.method === 'GET') return res.status(200).json({ deprecated: true, configured: false })
  return res.status(410).json({ error: 'Plaintext settings are disabled. Configure an encrypted project connector.', code: 'LEGACY_SETTINGS_DISABLED' })
}

export function legacySettingsReadEnabled() {
  return String(process.env.LEGACY_DIRECT_THINGSBOARD_ENABLED || '').trim().toLowerCase() === 'true'
}

export function normalizeLegacyMode(value) {
  const mode = String(Array.isArray(value) ? value[0] : value || 'global').trim()
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(mode) ? mode : 'global'
}
