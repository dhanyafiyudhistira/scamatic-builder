import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve, relative, sep } from 'node:path'
import { createZip } from './zip.js'
import { verifyDeployment, sha256, MAX_EXPORT_ZIP_BYTES, RUNTIME_FILES_FORMAT } from './contract.js'

const runtimeDependencies = ['compression', 'dotenv', 'express', 'mongodb', 'mongoose']

function productionLock(lock, version) {
  const records = lock.packages
  const dependencies = Object.fromEntries(runtimeDependencies.map(name => [name, records[`node_modules/${name}`].version]))
  const packages = { '': { name: 'scamatic-hosted-runtime', version, dependencies, engines: { node: '>=22' } } }
  function include(name, from = '', optional = false) {
    let prefix = from, key
    while (true) {
      const candidate = `${prefix ? prefix + '/' : ''}node_modules/${name}`
      if (records[candidate]) { key = candidate; break }
      if (!prefix) break
      prefix = prefix.slice(0, Math.max(0, prefix.lastIndexOf('node_modules/'))).replace(/\/$/, '')
    }
    if (!key) { if (optional) return; throw new Error(`Production lock is missing ${name}.`) }
    if (packages[key]) return
    const { dev, devOptional, ...record } = records[key]
    packages[key] = record
    for (const dependency of Object.keys(record.dependencies || {})) include(dependency, key, Boolean(record.optionalDependencies?.[dependency]))
    for (const dependency of Object.keys(record.optionalDependencies || {})) include(dependency, key, true)
  }
  runtimeDependencies.forEach(name => include(name))
  return { dependencies, lock: { name: 'scamatic-hosted-runtime', version, lockfileVersion: 3, requires: true, packages } }
}

export function runtimePackageFiles(root, deployment, target = 'node') {
  verifyDeployment(deployment)
  if (!['node', 'vercel'].includes(target)) throw new Error('Choose Node server or Vercel as export target.')
  root = realpathSync(root)
  const files = new Map()
  const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
  function source(path) {
    if (files.has(path)) return
    const absolute = realpathSync(resolve(root, path))
    if (!absolute.startsWith(root + sep) || !absolute.endsWith('.js')) throw new Error('Invalid runtime source dependency.')
    const content = readFileSync(absolute)
    files.set(path, content)
    const pattern = /\b(?:from\s*|import\s*\(\s*|import\s*)(['"])(\.[^'"]+)\1/g
    for (const match of content.toString().matchAll(pattern)) {
      const dependency = relative(root, resolve(dirname(absolute), match[2])).split(sep).join('/')
      source(dependency)
    }
  }
  for (const entry of ['hosted-runtime/server.js', 'hosted-runtime/app.js', 'hosted-runtime/provision.js', 'hosted-runtime/verify.js']) source(entry)
  function frontend(path) {
    const absolute = realpathSync(resolve(root, 'dist-hosted', path))
    if (!absolute.startsWith(resolve(root, 'dist-hosted') + sep)) throw new Error('Invalid hosted frontend asset.')
    if (statSync(absolute).isDirectory()) {
      for (const name of readdirSync(absolute)) frontend(path ? `${path}/${name}` : name)
    } else {
      if (/\.map$|\.env|BuilderPlatform|BuilderPanels/.test(path)) throw new Error('Unexpected file in hosted frontend.')
      files.set(`dist/${path}`, readFileSync(absolute))
    }
  }
  // index.html must exist; this also detects an installer missing the hosted build.
  files.set('dist/index.html', readFileSync(resolve(root, 'dist-hosted/index.html')))
  for (const name of readdirSync(resolve(root, 'dist-hosted'))) frontend(name)
  const packageVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  if (packageVersion !== deployment.engineVersion) throw new Error('Hosted engine version does not match this Builder.')
  const { dependencies, lock } = productionLock(JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')), packageVersion)
  files.set('package.json', json({ name: 'scamatic-hosted-runtime', version: packageVersion, private: true, type: 'module', engines: { node: '>=22' }, scripts: { start: 'node hosted-runtime/server.js', verify: 'node hosted-runtime/verify.js' }, dependencies }))
  files.set('package-lock.json', json(lock))
  files.set('deployment.json', json(deployment))
  files.set('LICENSE', readFileSync(resolve(root, 'LICENSE')))
  files.set('.gitignore', Buffer.from('node_modules/\n.env\n.env.*\n!.env.example\n'))
  files.set('.env.example', Buffer.from([
    'NODE_ENV=production', 'MONGO_URI=', 'APP_ORIGIN=https://YOUR-RUNTIME-DOMAIN',
    'SCADA_ADMIN_EMAIL=', 'SCADA_ADMIN_PASSWORD=', 'SCADA_CONNECTOR_MASTER_KEY=', 'SCADA_RUNTIME_PIN=',
    'CONNECTOR_ALLOWED_HOSTS=', 'CONNECTOR_EXECUTION_MODE=serverless', 'CONNECTOR_POLL_INTERVAL_MS=5000',
    '# Target credentials only: {"CONNECTOR_ID":{"jwt":"...","refreshToken":"..."}}',
    '# Keys CONNECTOR_ID:ENVIRONMENT are supported when one connector uses multiple environments.',
    'RUNTIME_THINGSBOARD_CREDENTIALS={}',
  ].join('\n') + '\n'))
  files.set('DEPLOY.md', readFileSync(resolve(root, 'hosted-runtime/DEPLOY.md')))
  files.set('Dockerfile', Buffer.from('FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nRUN npm run verify\nENV NODE_ENV=production\nEXPOSE 3000\nCMD ["npm", "start"]\n'))
  files.set('.dockerignore', Buffer.from('node_modules\n.env\n.env.*\n.git\n'))
  if (target === 'vercel') {
    source('hosted-runtime/vercel-entry.js')
    files.set('api/[route].js', Buffer.from("export { default } from '../hosted-runtime/vercel-entry.js'\nexport const config = { maxDuration: 30 }\n"))
    files.set('vercel.json', json({ version: 2, framework: null, installCommand: 'npm ci --omit=dev', buildCommand: 'npm run verify', outputDirectory: 'dist', functions: { 'api/[route].js': { maxDuration: 30, includeFiles: '{deployment.json,runtime-manifest.json,hosted-runtime/**,api/_handlers/**,api/_lib/**,shared/**,dist/**,package.json}' } }, rewrites: [{ source: '/runtime/:slug', destination: '/index.html' }], headers: [{ source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'X-Frame-Options', value: 'DENY' }, { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" }] }] }))
  }
  const inventory = [...files].map(([path, content]) => ({ path, sha256: sha256(content), bytes: content.length }))
  files.set('runtime-manifest.json', json({ format: RUNTIME_FILES_FORMAT, target, projectType: deployment.payload.project.projectType, policy: deployment.policy, engineVersion: packageVersion, deploymentId: deployment.deploymentId, files: inventory }))
  return files
}

export function exportRuntimePackage(root, deployment, target = 'node') {
  const files = runtimePackageFiles(root, deployment, target)
  const archive = createZip(files)
  if (archive.length > MAX_EXPORT_ZIP_BYTES) throw new Error('Runtime package exceeds the 3 MiB trial download limit. Reduce image sizes before exporting.')
  return { fileName: `${deployment.payload.project.slug}-runtime-v${deployment.payload.version.number}-${target}-${deployment.engineVersion}.zip`, contentBase64: archive.toString('base64'), bytes: archive.length, sha256: sha256(archive), target, policy: deployment.policy, sourceVersion: deployment.payload.version.number }
}
