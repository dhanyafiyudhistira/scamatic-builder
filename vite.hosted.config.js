import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root: resolve(root, 'hosted-runtime'),
  publicDir: false,
  plugins: [
    {
      name: 'hosted-browser-transport', enforce: 'pre',
      resolveId(source, importer) {
        if (importer && source.startsWith('.') && resolve(dirname(importer), source) === resolve(root, 'src/platform/desktop.js')) {
          return resolve(root, 'hosted-runtime/browser-transport.js')
        }
      },
      generateBundle(_, bundle) {
        for (const output of Object.values(bundle)) {
          for (const module of Object.keys(output.modules || {})) {
            if (/BuilderPlatform\.jsx|BuilderPanels\.jsx|Markup(?:Toolbar|Workspace)\.jsx|\/src\/App\.jsx|@tauri-apps|\/platform\/desktop\.js/.test(module.replaceAll('\\', '/'))) {
              throw new Error(`Editor/desktop module entered hosted runtime: ${module}`)
            }
          }
        }
      },
      closeBundle() {
        mkdirSync(resolve(root, 'dist-hosted'), { recursive: true })
        for (const name of ['logo-sb.png', 'check.svg', 'warning-triangle.svg', 'open-new-window (1).svg', 'grindstone-license.txt']) {
          copyFileSync(resolve(root, 'public', name), resolve(root, 'dist-hosted', name))
        }
      },
    }, react(),
  ],
  build: { outDir: resolve(root, 'dist-hosted'), emptyOutDir: true, sourcemap: false },
})
