import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const workspaceRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const stageRoot = resolve(workspaceRoot, 'target', 'desktop-runtime')
const nodeModulesRoot = resolve(workspaceRoot, 'node_modules')
const serviceSource = resolve(workspaceRoot, 'target', 'release', 'scamatic-runtime-service.exe')
const isaacSource = resolve(workspaceRoot, 'target', 'release', 'scamatic-data-plane.exe')
const targetTriple = process.env.SCAMATIC_DESKTOP_TARGET_TRIPLE || 'x86_64-pc-windows-msvc'
const sidecarDirectory = resolve(workspaceRoot, 'src-tauri', 'binaries')
const sidecarTarget = resolve(sidecarDirectory, `scamatic-runtime-service-${targetTriple}.exe`)
const nodeSource = resolveNodeBinary()

assertSafeStageDirectory(stageRoot)
requireFile(nodeSource, 'Node runtime')
requireFile(serviceSource, 'Windows service supervisor')
requireFile(isaacSource, 'Isaac data-plane')

rmSync(stageRoot, { recursive: true, force: true })
mkdirSync(stageRoot, { recursive: true })
mkdirSync(sidecarDirectory, { recursive: true })

for (const directory of ['server', 'api', 'shared', 'dist']) {
  const source = resolve(workspaceRoot, directory)
  if (!statSync(source).isDirectory()) throw new Error(`${directory} build input is missing`)
  cpSync(source, resolve(stageRoot, directory), { recursive: true })
}

mkdirSync(resolve(stageRoot, 'scripts'), { recursive: true })
cpSync(resolve(workspaceRoot, 'scripts', 'rotate-connector-master-key.js'), resolve(stageRoot, 'scripts', 'rotate-connector-master-key.js'))

for (const file of ['package.json', 'LICENSE']) {
  cpSync(resolve(workspaceRoot, file), resolve(stageRoot, file))
}
cpSync(resolve(workspaceRoot, 'src-tauri', 'runtime.env.example'), resolve(stageRoot, 'runtime.env.example'))
cpSync(nodeSource, resolve(stageRoot, 'node.exe'))
cpSync(isaacSource, resolve(stageRoot, 'scamatic-data-plane.exe'))
cpSync(serviceSource, sidecarTarget)

const packageRecords = copyProductionDependencyClosure([
  'compression',
  'cors',
  'dotenv',
  'express',
  'mongodb',
  'mongoose',
  'ws',
])

const manifest = {
  format: 1,
  application: readPackageJson(resolve(workspaceRoot, 'package.json')).version,
  generatedAt: new Date().toISOString(),
  targetTriple,
  node: {
    version: execFileSync(nodeSource, ['--version'], { encoding: 'utf8' }).trim(),
    sha256: sha256(resolve(stageRoot, 'node.exe')),
  },
  service: {
    sha256: sha256(sidecarTarget),
  },
  isaac: {
    sha256: sha256(resolve(stageRoot, 'scamatic-data-plane.exe')),
  },
  productionPackages: packageRecords,
  secretsBundled: false,
}
writeFileSync(resolve(stageRoot, 'runtime.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const stagedBytes = directoryBytes(stageRoot)
console.log(`Prepared desktop runtime: ${stageRoot}`)
console.log(`Production packages: ${packageRecords.length}`)
console.log(`Runtime payload: ${(stagedBytes / 1024 / 1024).toFixed(1)} MiB`)
console.log(`Service sidecar: ${sidecarTarget}`)

function resolveNodeBinary() {
  const configured = process.env.SCAMATIC_DESKTOP_NODE_BINARY
  if (configured) return resolve(configured)
  if (process.platform === 'win32' && basename(process.execPath).toLowerCase() === 'node.exe') return process.execPath
  throw new Error('Set SCAMATIC_DESKTOP_NODE_BINARY to a Windows node.exe used by the packaged service.')
}

function copyProductionDependencyClosure(seeds) {
  if (!existsSync(nodeModulesRoot)) throw new Error('node_modules is missing; install dependencies before staging the desktop runtime')
  const copied = new Map()
  for (const seed of seeds) includePackage(seed, nodeModulesRoot, false)
  return [...copied.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))

  function includePackage(name, searchRoot, optional) {
    const packageDirectory = resolveInstalledPackage(name, searchRoot)
    if (!packageDirectory) {
      if (optional) return
      throw new Error(`Production dependency ${name} could not be resolved from ${searchRoot}`)
    }
    const relativeDirectory = relative(nodeModulesRoot, packageDirectory)
    if (relativeDirectory.startsWith('..') || resolve(nodeModulesRoot, relativeDirectory) !== packageDirectory) {
      throw new Error(`Resolved package escaped node_modules: ${name}`)
    }
    if (copied.has(relativeDirectory)) return

    const metadata = readPackageJson(join(packageDirectory, 'package.json'))
    copied.set(relativeDirectory, {
      name: metadata.name || name,
      version: metadata.version || 'unknown',
      license: metadata.license || 'unknown',
      path: relativeDirectory.replaceAll('\\', '/'),
    })
    const destination = resolve(stageRoot, 'node_modules', relativeDirectory)
    cpSync(packageDirectory, destination, {
      recursive: true,
      filter: source => source === packageDirectory || basename(source).toLowerCase() !== 'node_modules',
    })

    const dependencies = { ...(metadata.dependencies || {}) }
    for (const dependencyName of Object.keys(dependencies)) {
      includePackage(dependencyName, packageDirectory, false)
    }
    for (const dependencyName of Object.keys(metadata.optionalDependencies || {})) {
      includePackage(dependencyName, packageDirectory, true)
    }
    for (const dependencyName of Object.keys(metadata.peerDependencies || {})) {
      const peerOptional = Boolean(metadata.peerDependenciesMeta?.[dependencyName]?.optional)
      includePackage(dependencyName, packageDirectory, peerOptional)
    }
  }
}

function resolveInstalledPackage(name, searchRoot) {
  let current = searchRoot
  while (current.startsWith(nodeModulesRoot)) {
    const candidate = resolve(current, 'node_modules', name)
    if (existsSync(resolve(candidate, 'package.json'))) return candidate
    if (current === nodeModulesRoot) {
      const rootCandidate = resolve(nodeModulesRoot, name)
      return existsSync(resolve(rootCandidate, 'package.json')) ? rootCandidate : null
    }
    current = dirname(dirname(current))
  }
  const rootCandidate = resolve(nodeModulesRoot, name)
  return existsSync(resolve(rootCandidate, 'package.json')) ? rootCandidate : null
}

function assertSafeStageDirectory(directory) {
  const targetDirectory = resolve(workspaceRoot, 'target')
  if (directory !== resolve(targetDirectory, 'desktop-runtime') || !directory.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error(`Refusing to replace unsafe staging directory: ${directory}`)
  }
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`)
}

function readPackageJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function directoryBytes(directory) {
  let bytes = 0
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) bytes += statSync(path).size
    }
  }
  return bytes
}
