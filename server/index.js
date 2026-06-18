import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import healthHandler    from '../api/health.js'
import settingsHandler  from '../api/settings.js'
import telemetryHandler from '../api/telemetry.js'

const app = express()

// CORS only matters for local dev (vite:5173 → express:3001).
// In production, frontend + /api live on one Vercel origin → no CORS needed.
app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))
app.use(express.json())

// app.all() forwards every HTTP method to the same handler — the handler
// already switches on req.method, so we don't need app.get/app.post pairs.
app.all('/api/health',    healthHandler)
app.all('/api/settings',  settingsHandler)
app.all('/api/telemetry', telemetryHandler)

const PORT = process.env.PORT || 3001
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Local dev API on http://localhost:${PORT}`)
})
