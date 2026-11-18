import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256, verifyDeployment, RUNTIME_FILES_FORMAT } from './contract.js'

export function verifyPackageFiles(root, { portable = false } = {}) {
  const base = realpathSync(root)
  const manifest = JSON.parse(readFileSync(resolve(base, 'runtime-manifest.json'), 'utf8'))
  if (manifest.format !== RUNTIME_FILES_FORMAT || !Array.isArray(manifest.files) || manifest.files.length > 500) throw new Error('Runtime file manifest is invalid.')
  for (const file of manifest.files) {
    // A function provider may transform server source. Immutable deployment and
    // frontend bytes must still match after that packaging step.
    if (portable && file.path !== 'deployment.json' && !file.path.startsWith('dist/')) continue
    const path = realpathSync(resolve(base, file.path))
    if (!path.startsWith(base + sep) || !statSync(path).isFile() || sha256(readFileSync(path)) !== file.sha256) throw new Error('Runtime package file integrity check failed.')
  }
  verifyDeployment(JSON.parse(readFileSync(resolve(base, 'deployment.json'), 'utf8')))
  return manifest
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPackageFiles(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  console.log('Runtime package integrity verified.')
}
