import { MongoClient } from 'mongodb'
import { createHash } from 'node:crypto'
import { chartStorageConfig } from '../../shared/chart-storage-config.js'
import { adaptiveChartResolution, normalizeChartRange } from '../../shared/chart-time-range.js'

const cache = globalThis.__chart_telemetry_stores__ ??= new Map()

export async function ensureChartTelemetryStore(options = {}) {
  const config = options.config || chartStorageConfig(options.environment)
  if (!config.enabled) throw unavailableError('Chart telemetry storage is not configured.')
  const fingerprint = createHash('sha256').update(`${config.uri}|${config.dbName}|${config.collectionName}|${config.retentionDays}|${config.maxPoolSize}`).digest('hex')
  const cached = cache.get(fingerprint)
  if (cached?.collection) return { collection: cached.collection, config }

  const client = new MongoClient(config.uri, {
    maxPoolSize: config.maxPoolSize,
    minPoolSize: 0,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
    retryWrites: true,
  })
  try {
    await client.connect()
    const database = client.db(config.dbName)
    const existing = await database.listCollections({ name: config.collectionName }, { nameOnly: false }).next()
    if (!existing) {
      await database.createCollection(config.collectionName, {
        timeseries: { timeField: 'timestamp', metaField: 'meta', granularity: 'seconds' },
        expireAfterSeconds: config.retentionDays * 86_400,
      })
    } else if (existing.type !== 'timeseries' && !existing.options?.timeseries) {
      throw Object.assign(new Error('Configured Chart collection must be a MongoDB time-series collection.'), { code: 'CHART_STORAGE_COLLECTION_TYPE' })
    } else if (Number(existing.options?.expireAfterSeconds) !== config.retentionDays * 86_400) {
      await database.command({ collMod: config.collectionName, expireAfterSeconds: config.retentionDays * 86_400 })
    }
    const collection = database.collection(config.collectionName)
    await collection.createIndex({ 'meta.workspaceId': 1, 'meta.projectId': 1, 'meta.tagId': 1, timestamp: -1 })
    cache.set(fingerprint, { client, collection })
    return { collection, config }
  } catch (error) {
    await client.close().catch(() => {})
    cache.delete(fingerprint)
    if (error?.code === 'CHART_STORAGE_COLLECTION_TYPE') throw error
    throw unavailableError('Chart telemetry storage is unavailable.', error)
  }
}

export async function writeChartTelemetrySamples(events, options = {}) {
  const documents = (Array.isArray(events) ? events : []).map(normalizeChartTelemetryEvent).filter(Boolean)
  if (!documents.length) return { inserted: 0 }
  const { collection } = await ensureChartTelemetryStore(options)
  const result = await collection.insertMany(documents, { ordered: false })
  return { inserted: result.insertedCount }
}

export async function readChartTelemetryHistory({ workspaceId, projectId, tagIds, since, limitPerTag }, options = {}) {
  const safeTagIds = [...new Set((tagIds || []).map(String).filter(Boolean))].slice(0, 50)
  const safeLimit = Math.max(1, Math.min(2000, Math.trunc(Number(limitPerTag)) || 300))
  if (!workspaceId || !projectId || !safeTagIds.length) return {}
  const { collection } = await ensureChartTelemetryStore(options)
  const rows = await collection.aggregate([
    {
      $match: {
        'meta.workspaceId': String(workspaceId),
        'meta.projectId': String(projectId),
        'meta.tagId': { $in: safeTagIds },
        timestamp: { $gte: new Date(since) },
      },
    },
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: '$meta.tagId',
        points: {
          $push: {
            timestamp: '$timestamp',
            value: '$value',
            quality: '$quality',
            sequence: '$sequence',
          },
        },
      },
    },
    { $project: { _id: 1, points: { $slice: ['$points', safeLimit] } } },
  ], { allowDiskUse: true }).toArray()

  return Object.fromEntries(rows.map(row => [
    row._id,
    row.points.reverse().map(point => ({
      timestamp: point.timestamp instanceof Date ? point.timestamp.toISOString() : point.timestamp,
      value: point.value,
      quality: point.quality,
      sequence: point.sequence,
    })),
  ]))
}

export async function readChartTelemetryRange({ workspaceId, projectId, tagIds, from, to, targetPoints }, options = {}) {
  const safeTagIds = [...new Set((tagIds || []).map(String).filter(Boolean))].slice(0, 50)
  if (!workspaceId || !projectId || !safeTagIds.length) return emptyRange(from, to, targetPoints)
  const range = normalizeChartRange({ from, to, targetPoints }, { now: options.now ?? Date.now() })
  const resolution = adaptiveChartResolution(range.rangeMs, range.targetPoints)
  const { collection } = await ensureChartTelemetryStore(options)
  const rows = await collection.aggregate([
    {
      $match: {
        'meta.workspaceId': String(workspaceId),
        'meta.projectId': String(projectId),
        'meta.tagId': { $in: safeTagIds },
        timestamp: { $gte: range.from, $lte: range.to },
      },
    },
    { $sort: { timestamp: 1 } },
    {
      $group: {
        _id: {
          tagId: '$meta.tagId',
          bucket: {
            $dateTrunc: {
              date: '$timestamp',
              unit: resolution.unit,
              binSize: resolution.binSize,
              timezone: 'UTC',
            },
          },
        },
        first: { $first: '$value' },
        last: { $last: '$value' },
        min: { $min: '$value' },
        max: { $max: '$value' },
        avg: { $avg: '$value' },
        count: { $sum: 1 },
        sequence: { $last: '$sequence' },
      },
    },
    { $sort: { '_id.tagId': 1, '_id.bucket': 1 } },
    {
      $group: {
        _id: '$_id.tagId',
        points: {
          $push: {
            timestamp: '$_id.bucket',
            value: '$avg',
            first: '$first',
            last: '$last',
            min: '$min',
            max: '$max',
            count: '$count',
            sequence: '$sequence',
          },
        },
      },
    },
  ], { allowDiskUse: true, maxTimeMS: 8_000 }).toArray()

  const history = Object.fromEntries(rows.map(row => [
    row._id,
    row.points.slice(-range.targetPoints).map(point => ({
      timestamp: point.timestamp instanceof Date ? point.timestamp.toISOString() : point.timestamp,
      value: point.value,
      first: point.first,
      last: point.last,
      min: point.min,
      max: point.max,
      count: point.count,
      quality: 'good',
      sequence: point.sequence,
      resolutionMs: resolution.bucketMs,
    })),
  ]))
  return {
    history,
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    resolutionMs: resolution.bucketMs,
    targetPoints: range.targetPoints,
  }
}

export async function deleteProjectChartTelemetry({ workspaceId, projectId }, options = {}) {
  const { collection } = await ensureChartTelemetryStore(options)
  return collection.deleteMany({ 'meta.workspaceId': String(workspaceId), 'meta.projectId': String(projectId) })
}

export function normalizeChartTelemetryEvent(event, now = Date.now()) {
  if (event?.quality && event.quality !== 'good') return null
  const value = Number(event?.value)
  const timestamp = new Date(event?.sourceTimestamp ?? event?.timestamp ?? event?.receivedAt ?? now)
  const receivedAt = new Date(event?.receivedAt ?? now)
  const workspaceId = boundedText(event?.workspaceId, 120)
  const projectId = boundedText(event?.projectId, 120)
  const sourceId = boundedText(event?.sourceId || 'unknown', 120)
  const tagId = boundedText(event?.tagId ?? event?.tag, 120)
  if (!workspaceId || !projectId || !tagId || !Number.isFinite(value) || !Number.isFinite(timestamp.getTime()) || !Number.isFinite(receivedAt.getTime())) return null
  return {
    meta: { workspaceId, projectId, sourceId, tagId },
    timestamp,
    receivedAt,
    value,
    quality: 'good',
    sequence: Number.isFinite(Number(event?.sequence)) ? Number(event.sequence) : null,
  }
}

function boundedText(value, max) {
  const text = String(value || '').trim()
  return text && text.length <= max ? text : ''
}

function unavailableError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: 'CHART_STORAGE_UNAVAILABLE' })
}

function emptyRange(from, to, targetPoints) {
  const range = normalizeChartRange({ from, to, targetPoints })
  const resolution = adaptiveChartResolution(range.rangeMs, range.targetPoints)
  return {
    history: {},
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    resolutionMs: resolution.bucketMs,
    targetPoints: range.targetPoints,
  }
}
