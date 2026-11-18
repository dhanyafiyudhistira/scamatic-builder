import 'dotenv/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntimeApp } from './app.js'
import { readDeployment, deploymentProvisioner } from './provision.js'
import { verifyPackageFiles } from './verify.js'
import { disconnectMongo } from '../api/_lib/mongo.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.env.NODE_ENV ||= 'production'
process.env.CONNECTOR_EXECUTION_MODE = 'serverless'
process.env.CONNECTOR_PLATFORM_ENABLED = 'false'
process.env.CONNECTOR_LIVE_COMMANDS_ENABLED = 'false'
const deployment = readDeployment(root)
verifyPackageFiles(root)
const ready = deploymentProvisioner(deployment)
await ready()
const app = createRuntimeApp({ deployment, root, ready })
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Hosted ${deployment.payload.project.projectType} runtime ${deployment.engineVersion}: ${deployment.policy}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(() => { void disconnectMongo().finally(() => process.exit(0)) }) })
