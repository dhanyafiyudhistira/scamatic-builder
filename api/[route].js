import audit from './_handlers/audit.js'
import auth from './_handlers/auth.js'
import chartStorage from './_handlers/chart-storage.js'
import commands from './_handlers/commands.js'
import connectors from './_handlers/connectors.js'
import draft from './_handlers/draft.js'
import elements from './_handlers/elements.js'
import health from './_handlers/health.js'
import members from './_handlers/members.js'
import projects from './_handlers/projects.js'
import publish from './_handlers/publish.js'
import runtime from './_handlers/runtime.js'
import runtimeSession from './_handlers/runtime-session.js'
import runtimeTelemetry from './_handlers/runtime-telemetry.js'
import settings from './_handlers/settings.js'
import simulationSequence from './_handlers/simulation-sequence.js'
import simulator from './_handlers/simulator.js'
import svg from './_handlers/svg.js'
import signup from './_handlers/signup.js'
import telemetry from './_handlers/telemetry.js'
import versions from './_handlers/versions.js'

const handlers = Object.freeze({
  audit,
  auth,
  'chart-storage': chartStorage,
  commands,
  connectors,
  draft,
  elements,
  health,
  members,
  projects,
  publish,
  runtime,
  'runtime-session': runtimeSession,
  'runtime-telemetry': runtimeTelemetry,
  settings,
  'simulation-sequence': simulationSequence,
  simulator,
  svg,
  signup,
  telemetry,
  versions,
})

export const config = { maxDuration: 30 }

export default function handler(req, res) {
  const route = Array.isArray(req.query?.route) ? req.query.route[0] : String(req.query?.route || '')
  const selected = handlers[route]
  if (!selected) return res.status(404).json({ error: 'API route not found.', code: 'API_ROUTE_NOT_FOUND' })
  return selected(req, res)
}
