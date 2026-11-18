import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntimeApp } from './app.js'
import { readDeployment, deploymentProvisioner } from './provision.js'
import { verifyPackageFiles } from './verify.js'

process.env.NODE_ENV ||= 'production'
process.env.CONNECTOR_EXECUTION_MODE = 'serverless'
process.env.CONNECTOR_PLATFORM_ENABLED = 'false'
process.env.CONNECTOR_LIVE_COMMANDS_ENABLED = 'false'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const deployment = readDeployment(root)
verifyPackageFiles(root, { portable: true })
const app = createRuntimeApp({ deployment, root, ready: deploymentProvisioner(deployment) })

export default function handler(req, res) {
  const route = req.query?.route
  if (typeof route !== 'string' || !/^[a-z-]+$/.test(route)) return res.status(404).end()
  const query = new URLSearchParams(Object.entries(req.query || {}).filter(([key]) => key !== 'route'))
  req.url = '/api/' + route + (query.size ? '?' + query : '')
  return app(req, res)
}
