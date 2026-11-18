import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareDesignAsset } from '../api/_lib/design-assets.js'
import { applyArcFinish, arcTokens } from './grindstone-arc-finish.js'

// Run with node --experimental-transform-types against this upstream archive.
// Normal Canvas Lab builds consume the committed export and require no download.
const commit = 'b690775a09afcaaf6b61b4afed59d3aacf24196c'
const source = process.argv[2]
if (!source) throw new Error(`Provide the Grindstone Visual Toolkit source directory at ${commit}.`)

const fromToolkit = path => import(pathToFileURL(resolve(source, path)).href)
const { FAMILIES, generate } = await fromToolkit('lib/symbols/index.ts')
const { renderSvg } = await fromToolkit('lib/render.ts')
const output = fileURLToPath(new URL('../builder-egui/assets/grindstone/', import.meta.url))
const repository = 'https://github.com/Grindstone-Systems/visual-toolkit'
const options = { style: 'modern-flat', theme: 'dark', state: 'normal', mode: 'resolved', animate: false, background: false, embedRecipe: false }

const presets = [
  ...FAMILIES.filter(family => family.generator),
  { name: 'Straight Pipe', generator: 'pipe.fitting', id: 'pipe.straight', params: { fitting: 'spool', ends: 'welded' }, stretch: true },
]

const symbols = presets.map(({ name, generator, id = generator, params, stretch = false }) => {
  const fileName = `grindstone-${id.replace('.', '-')}.svg`
  const idPrefix = fileName.slice(0, -4)
  const object = generate(generator, { label: '', ...params })
  const mimeType = 'image/svg+xml'
  const flat = prepareDesignAsset({ fileName, mimeType, content: renderSvg(object, { ...options, idPrefix }) })
  const svg = renderSvg(object, { ...options, idPrefix, tokens: arcTokens })
  const asset = prepareDesignAsset({ fileName, mimeType, content: applyArcFinish(svg, object, idPrefix) })
  asset.metadata.source = `${repository}/tree/${commit}`
  asset.metadata.finish = 'skeuomorphic-arc'
  if (params) asset.metadata.generator = object.generator
  return { generator: id, label: name, ...(stretch ? { stretch } : {}), flatAssetId: `grindstone-${flat.checksum}`, asset: { _id: `grindstone-${asset.checksum}`, ...asset } }
})

mkdirSync(output, { recursive: true })
copyFileSync(resolve(source, 'LICENSE'), resolve(output, 'LICENSE.txt'))
writeFileSync(resolve(output, 'catalog.json'), JSON.stringify({ repository, commit, options, finish: 'skeuomorphic-arc', symbols }, null, 2) + '\n')
console.log(`Exported ${symbols.length} Grindstone industrial symbols.`)
