import mongoose from 'mongoose'

// In serverless, this module can be imported many times across cold/warm
// cycles. Guard against `OverwriteModelError` by reusing any model already
// registered on the mongoose instance.
function defineModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema)
}

// One document per mode ('default' | 'deck-user'), keyed by _id.
// A legacy 'global' doc may still exist from the pre-mode schema; the
// settings handler falls back to it when 'default' is missing.
const settingsSchema = new mongoose.Schema({
  _id:       { type: String, default: 'global' },
  serverUrl: { type: String, default: '' },
  deviceId:  { type: String, default: '' },
  token:     { type: String, default: '' },
  updatedAt: { type: Date,   default: Date.now }
}, { _id: false })

export const Settings = defineModel('Settings', settingsSchema)

const telemetrySchema = new mongoose.Schema({
  tag:       { type: String, required: true, index: true },
  value:     { type: Number, required: true },
  timestamp: { type: Date,   default: Date.now, index: true }
})
telemetrySchema.index({ tag: 1, timestamp: -1 })

export const Telemetry = defineModel('Telemetry', telemetrySchema)
