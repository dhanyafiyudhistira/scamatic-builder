import 'dotenv/config'
import { connectMongo } from '../api/_lib/mongo.js'
import { Project, ProjectVersion, ScadaAsset } from '../api/_lib/models.js'

await connectMongo()
const projects = await Project.find({}).lean()
let versionUpdates = 0

for (const project of projects) {
  const versions = await ProjectVersion.find({ projectId: project._id }).sort({ version: 1 })
  for (const version of versions) {
    const assetId = version.assetId || version.schema?.project?.svgAssetId
    const asset = assetId ? await ScadaAsset.findById(assetId).lean() : null
    const patch = {}
    if (!version.idempotencyKey) patch.idempotencyKey = `legacy_${version.id}`
    if (!version.message) patch.message = 'Legacy published snapshot'
    if (!version.draftRevision) patch.draftRevision = 1
    if (!version.assetId && assetId) patch.assetId = assetId
    if (!version.assetChecksum && asset) patch.assetChecksum = asset.checksum
    if (!version.environmentRef) patch.environmentRef = 'mock'
    if (Object.keys(patch).length) { await ProjectVersion.updateOne({ _id: version.id }, { $set: patch }); versionUpdates += 1 }
  }
  const latestNumber = versions.at(-1)?.version || 0
  if ((project.lastVersionNumber || 0) < latestNumber) await Project.updateOne({ _id: project._id }, { $set: { lastVersionNumber: latestNumber } })
}

console.log(JSON.stringify({ projects: projects.length, versionUpdates }, null, 2))
process.exit(0)
