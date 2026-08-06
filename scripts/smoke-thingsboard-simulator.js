import { spawn } from 'node:child_process'
import { once } from 'node:events'

const cwd = new URL('..', import.meta.url)
const simulator = spawn(process.execPath, ['scripts/thingsboard-simulator.js'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let simulatorError = ''
simulator.stderr.on('data', chunk => { simulatorError += String(chunk).slice(0, 2000) })

try {
  await waitForSimulator()
  const verifier = spawn(process.execPath, ['scripts/verify-thingsboard-simulator.js'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  verifier.stdout.on('data', chunk => { stdout += String(chunk).slice(0, 4000) })
  verifier.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 4000) })
  const [code] = await once(verifier, 'exit')
  if (code !== 0) throw new Error(stderr.trim() || `Simulator verifier exited with code ${code}.`)
  process.stdout.write(stdout)
} finally {
  simulator.kill('SIGTERM')
  await Promise.race([once(simulator, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])
}

async function waitForSimulator() {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (simulator.exitCode != null) throw new Error(simulatorError.trim() || 'Simulator exited before becoming ready.')
    try {
      const response = await fetch('http://127.0.0.1:8090/api/auth/user', { headers: { 'X-Authorization': 'Bearer staging-simulator-token-change-me' }, signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch { /* Retry until the bounded deadline. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Simulator did not become ready within 6 seconds.')
}
