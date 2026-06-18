# Vercel Serverless API — Architecture Reference

Dokumen ini merangkum transisi backend SCADA `pulsator+filter` dari
**Express server long-running** (semula di-target untuk Fly.io) menjadi
**Vercel Serverless Functions**. Tujuannya: pattern yang sama bisa
di-port ke SCADA lain tanpa harus mengulangi trial-and-error yang sudah
dilakukan di sini.

## 1. Kenapa pindah

| Aspek | Express server (Fly.io / Render) | Vercel API Routes |
|---|---|---|
| Hosting | Butuh container Docker + platform terpisah | Sama dengan frontend (satu Vercel project) |
| Credit card | Fly.io wajib CC sejak Okt 2024 (meski free tier ada) | Tidak perlu CC selamanya untuk hobby tier |
| CORS | Cross-origin → setup `cors()` middleware + env var origin | Same-origin (`/api/*` native) → CORS no-op |
| Deploy | `fly deploy` (Docker build) terpisah dari frontend | Satu `git push` deploy semua-nya |
| Cold start | Sleep 15 menit → wake 30 dtk (Render) atau auto-stop machine (Fly) | ~100ms warm, ~500ms cold (mongoose connect dominan) |
| Idle cost | Bayar resources meski idle (jika tidak auto-stop) | $0 idle, bayar per-invocation |
| Long-lived connection | OK (WebSocket server, cron internal) | **TIDAK** cocok — function max 10–60 dtk |
| Local dev | Express langsung jalan | Butuh `vercel dev` ATAU Express wrapper (lihat §6) |

**Decision criteria untuk SCADA berikutnya:**

Pakai **Vercel serverless** kalau:
- Backend hanya REST endpoints (CRUD ke DB, proxy ke vendor API)
- Frontend juga di Vercel
- Tidak butuh long-lived WebSocket server-side
- Telemetry streaming dilakukan oleh **client-side** WebSocket (mis. browser ↔ ThingsBoard langsung)

Pakai **Express long-running** (Fly.io / Render / Koyeb) kalau:
- Backend harus jaga WebSocket server (mis. broker MQTT custom)
- Cron job atau background worker server-side
- Function execution >60 detik (Vercel timeout)
- State in-memory yang harus persist antar request (cache besar, queue)

SCADA kami **memenuhi semua syarat Vercel** karena ThingsBoard WS direct dari
browser, tidak ada cron, payload kecil.

---

## 2. Arsitektur Before / After

### Before (Express long-running)

```
                ┌──────────────┐  fetch /api/*
  Browser ────▶ │ Vite static  │ ─────────────┐
                │  (Vercel)    │              │ vite proxy
                └──────────────┘              ▼
                                     ┌────────────────┐
                                     │ Express :3001  │
                                     │ (Fly.io)       │
                                     └───────┬────────┘
                                             │ mongoose
                                             ▼
                                       MongoDB Atlas
```

- Frontend + backend di platform terpisah → CORS, double-deploy, double-monitor
- Server hidup 24/7 (atau auto-stop) → bayar/quota terpakai meski idle

### After (Vercel serverless)

```
                ┌────────────────────────────────────┐
                │           Vercel project           │
                │  ┌────────┐  same origin  ┌──────┐ │
  Browser ────▶ │  │ Static │ ────────────▶│ /api │ │
                │  │ (Vite) │   /api/*      │ fns  │ │
                │  └────────┘               └──┬───┘ │
                └─────────────────────────────│──────┘
                                              │ mongoose
                                              ▼
                                       MongoDB Atlas
```

- Satu platform → satu deploy, satu URL, no CORS
- Function dipanggil per-request, mati setelah selesai

---

## 3. Struktur file (konvensi Vercel)

```
project-root/
├── api/                          ← Vercel auto-detect setiap *.js sebagai function
│   ├── _lib/                     ← prefix `_` = NOT exposed sebagai route
│   │   ├── mongo.js              ← shared connection cache
│   │   └── models.js             ← shared Mongoose schemas
│   ├── health.js                 ← GET /api/health
│   ├── settings.js               ← GET+POST /api/settings
│   └── telemetry.js              ← GET+POST /api/telemetry
├── src/                          ← Frontend Vite/React
├── server/
│   └── index.js                  ← Express wrapper untuk LOCAL DEV (opsional)
├── vercel.json
└── package.json
```

### Konvensi penting

- File di `api/` jadi route `/api/<filename>` otomatis. `api/foo.js` → `/api/foo`.
- File/folder dengan prefix `_` **tidak** di-expose. Pakai untuk shared utility.
- Tidak ada subfolder routes by default; `api/admin/users.js` → `/api/admin/users`.
- Setiap file `api/*.js` adalah **handler tersendiri** dengan bundle terpisah —
  artinya `mongoose` ter-bundle 3× kalau Anda punya 3 file API. Bukan masalah
  selama < 50 MB compressed (limit hobby tier).

---

## 4. Handler signature (Vercel function)

```js
// api/example.js
export default async function handler(req, res) {
  // req.method, req.query, req.body, req.headers
  // res.status(...).json(...) / res.send(...) / res.setHeader(...)

  if (req.method === 'GET') {
    return res.status(200).json({ hello: 'world' })
  }

  if (req.method === 'POST') {
    const data = req.body          // JSON auto-parsed kalau Content-Type sesuai
    return res.status(201).json({ saved: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: `Method ${req.method} not allowed` })
}
```

**Key differences dari Express:**

| Express | Vercel |
|---|---|
| `app.get('/api/x', (req, res) => …)` | export default + check `req.method` |
| Middleware via `app.use(...)` | Composable wrapper (lihat §10) |
| `req.params` (path params) | Pakai folder-based: `api/users/[id].js` → `req.query.id` |
| `req.body` butuh `express.json()` | Auto-parsed JSON |
| Long-lived state via globals | OK juga, **tapi dihapus saat cold start** |

---

## 5. Pattern penting #1 — Connection cache via globalThis

**Masalah**: setiap kali Vercel function dipanggil "cold", Node baru dispawn,
mongoose harus connect ulang ke Atlas (~200–500ms TLS handshake). Kalau
diulang setiap request, biaya latency tinggi.

**Solusi**: cache koneksi di `globalThis`. Saat function "warm" (proses Node
yang sama di-reuse), cache tetap ada dan koneksi di-skip.

```js
// api/_lib/mongo.js
import mongoose from 'mongoose'

const cache = globalThis.__mongoose_cache__ ??= { conn: null, promise: null }

export async function connectMongo() {
  if (cache.conn) return cache.conn

  const uri = process.env.MONGO_URI
  if (!uri) throw new Error('MONGO_URI env var is not set')

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(uri, { serverSelectionTimeoutMS: 8000 })
      .catch(err => {
        cache.promise = null            // allow retry on next call
        throw err
      })
  }

  cache.conn = await cache.promise
  return cache.conn
}
```

### Kenapa pakai `globalThis.__mongoose_cache__` (bukan module-level `let`)?

- Module-level `let` juga bertahan antar warm invocation.
- Tapi Vercel **kadang reload module** saat HMR / hot deploy → variable hilang.
- `globalThis` tidak terkena module reload → cache lebih durable.

### Pattern penanganan promise vs conn

| Skenario | State |
|---|---|
| First call ever | `cache.conn = null, cache.promise = null` → connect dimulai |
| Concurrent first calls | Sama-sama menunggu `cache.promise` yang sama → 1 koneksi, bukan 5 |
| Connect berhasil | `cache.conn` terisi, panggilan berikutnya langsung pakai |
| Connect gagal | `cache.promise` di-reset → call berikutnya retry |

Tanpa `cache.promise`, dua concurrent cold-start akan trigger dua mongoose
connect — boros koneksi pool Atlas.

---

## 6. Pattern penting #2 — Shared models (avoid re-registration)

**Masalah**: `mongoose.model('Name', schema)` throws `OverwriteModelError`
kalau dipanggil kedua kali untuk nama yang sama. Di serverless, modul bisa
ter-import berkali-kali (cold/warm cycle, HMR, dll).

**Solusi**: guard model definition.

```js
// api/_lib/models.js
import mongoose from 'mongoose'

function defineModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema)
}

const settingsSchema = new mongoose.Schema({
  _id:       { type: String, default: 'global' },
  serverUrl: { type: String, default: '' },
  // ...
}, { _id: false })

export const Settings = defineModel('Settings', settingsSchema)
```

`mongoose.models[name]` adalah dict yang ke-isi setelah `model()` pertama
dipanggil. Cek dulu sebelum register ulang — `OverwriteModelError` tidak
akan muncul.

---

## 7. Pattern penting #3 — Method routing dalam satu file

Karena setiap file `api/*.js` = satu function = satu handler, GET dan POST
untuk endpoint yang sama harus dilakukan dalam **satu fungsi**:

```js
import { connectMongo } from './_lib/mongo.js'
import { Settings } from './_lib/models.js'

export default async function handler(req, res) {
  try {
    await connectMongo()

    if (req.method === 'GET') {
      const doc = await Settings.findById(req.query.mode || 'global').lean()
      return res.status(200).json(doc ?? {})
    }

    if (req.method === 'POST') {
      const { serverUrl, deviceId, token } = req.body || {}
      await Settings.findByIdAndUpdate('global', {
        serverUrl, deviceId, token, updatedAt: new Date()
      }, { upsert: true })
      return res.status(200).json({ ok: true })
    }

    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: `Method ${req.method} not allowed` })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
```

**Pola yang konsisten:**
1. `try` block dengan single `await connectMongo()` di awal
2. Switch via `req.method`
3. Setiap branch return langsung
4. Default branch → 405 dengan `Allow` header
5. Single `catch` untuk semua method → 500 dengan error message

Jangan pakai `switch(req.method)` kecuali handler-nya kompleks — `if` chain
lebih mudah dibaca.

---

## 8. Pattern penting #4 — Local dev wrapper

Karena `vercel dev` lebih lambat dari Vite HMR + Express langsung, kami pertahankan `server/index.js` sebagai **thin Express wrapper** yang mount handler `api/*.js`. Local dev tetap pakai `npm run dev` (vite + express concurrently), production pakai Vercel function langsung. **Satu source of truth** untuk handler logic.

```js
// server/index.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import healthHandler    from '../api/health.js'
import settingsHandler  from '../api/settings.js'
import telemetryHandler from '../api/telemetry.js'

const app = express()

// CORS only matters for local dev (vite:5173 → express:3001).
// In production both live on Vercel under one origin → no CORS needed.
app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))
app.use(express.json())

// app.all() = forward semua HTTP method ke handler.
// Handler sudah switch req.method sendiri, jadi tidak perlu app.get/post.
app.all('/api/health',    healthHandler)
app.all('/api/settings',  settingsHandler)
app.all('/api/telemetry', telemetryHandler)

const PORT = process.env.PORT || 3001
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Local dev API on http://localhost:${PORT}`)
})
```

`vite.config.js` proxy `/api → :3001`:

```js
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true }
    }
  }
})
```

`package.json`:

```json
{
  "scripts": {
    "dev":          "concurrently -n vite,api -c cyan,yellow \"vite\" \"node server/index.js\"",
    "dev:frontend": "vite",
    "dev:server":   "node server/index.js",
    "build":        "vite build"
  },
  "type": "module",
  "engines": { "node": ">=18" }
}
```

### Alternatif: pakai `vercel dev`

Kalau tidak mau dual implementation, hapus `server/index.js` dan `concurrently`, ganti `"dev": "vercel dev"`. Tradeoff:
- ✓ Single command, mirror exact production behavior
- ✗ HMR lebih lambat dari vite langsung
- ✗ Butuh Vercel CLI ter-install
- ✗ Function startup time ~3 dtk di dev

Kami pilih Express wrapper untuk speed iteration.

---

## 9. `vercel.json` — minimum config

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "installCommand": "npm install"
}
```

Catatan:
- **`framework: "vite"`** memberitahu Vercel pakai builder Vite (cache optimal, fast refresh).
- **`outputDirectory: "dist"`** = output Vite default.
- **TIDAK ADA `rewrites`** untuk `/api/*` — Vercel otomatis route ke
  `api/*.js`. Rewrite hanya dibutuhkan kalau API di domain lain (mis.
  proxy ke Fly.io).
- Tidak set `regions` → default region (Washington DC `iad1`). Set
  `"regions": ["sin1"]` kalau MongoDB Atlas Anda di Asia.

---

## 10. `.vercelignore` — kunci deploy ringan

Tanpa ini, Vercel CLI bisa upload `node_modules` (73 MB di proyek kami) dan semua docs. Vercel `npm install` ulang di build container, jadi local node_modules cuma boros bandwidth upload.

```gitignore
# Vercel re-installs from package.json during build, never upload these.
node_modules
dist
.vercel

# Local-dev only — Vercel uses /api/*.js directly.
server

# Docs — bloat the deployment.
*.md
!README.md

# Misc
.DS_Store
npm-debug.log*
.env
.env.*
.git
.gitignore
```

---

## 11. Environment Variables

### Required

| Var | Pakai di | Contoh |
|---|---|---|
| `MONGO_URI` | `api/_lib/mongo.js` | `mongodb+srv://user:pass@cluster.mongodb.net/dbname?retryWrites=true&w=majority` |

### Set via dashboard

[https://vercel.com/&lt;org&gt;/&lt;project&gt;/settings/environment-variables](https://vercel.com)

- Centang **Production**, **Preview**, **Development** kalau mau berlaku di semua environment.
- Pakai dotenv `.env` (di-`.gitignore`!) untuk local dev:
  ```
  MONGO_URI=mongodb+srv://...
  ```

### Tidak perlu lagi

| Var | Kenapa |
|---|---|
| `CORS_ORIGIN` | Same-origin di Vercel → no CORS |
| `PORT` | Vercel manage sendiri |
| `NODE_ENV` | Auto-set ke `production` di build |

---

## 12. MongoDB Atlas — network access

Vercel functions punya **IP dinamis** (banyak edge node, dan rotasi). Cara
realistis:

1. Atlas → **Network Access** → **Add IP Address**
2. Pilih **Allow access from anywhere** (`0.0.0.0/0`)
3. Comment: `Vercel serverless functions`

Keamanan tetap terjaga via:
- Username + password yang strong di connection string
- Database user dengan role **terbatas** (cuma `readWrite` ke DB yang dipakai, bukan admin cluster-wide)
- Audit log Atlas

### Connection pool considerations

Mongoose default pool size: 5 koneksi per process. Di serverless, setiap function instance punya pool sendiri. Kalau ada N instance running paralel, total koneksi ke Atlas = N × 5.

Atlas free tier limit: **500 koneksi total**. Praktis tidak masalah untuk SCADA dengan traffic operator (<10 RPS), tapi untuk app dengan ribuan user paralel, set `maxPoolSize` manual:

```js
mongoose.connect(uri, {
  maxPoolSize: 3,
  serverSelectionTimeoutMS: 8000
})
```

---

## 13. Deploy workflow

### Initial setup (sekali saja)

```bash
# 1. Install Vercel CLI (opsional, untuk deploy CLI / link project)
npm i -g vercel

# 2. Link folder ke Vercel project (membuat .vercel/project.json)
vercel link

# 3. Set env var via CLI atau dashboard
vercel env add MONGO_URI production
# → paste connection string saat prompt
```

### Deploy rutin

**Via Git push** (recommended):

```bash
git push origin main   # → auto-deploy production
git push origin <branch>   # → preview deployment
```

**Via CLI**:

```bash
vercel              # → preview
vercel --prod       # → production
```

---

## 14. Function size & timeout limits

| Tier | Function bundle | Timeout | Memory |
|---|---|---|---|
| Hobby (free) | 50 MB compressed | 10 dtk | 1024 MB |
| Pro | 250 MB | 60 dtk | 3008 MB |

Untuk SCADA REST endpoints: **jauh di bawah limit**. Mongoose + dependencies ≈ 5-8 MB compressed per function.

**Cara cek bundle size lokal**:

```bash
vercel build
ls -lh .vercel/output/functions/api/*.func/
```

### Bila mendekati limit

- Pisah file `api/` jadi sub-folder agar bundle terpecah (`api/settings/get.js`, `api/settings/post.js`).
- Pakai `vercel.json > functions` untuk override `maxDuration`:

```json
{
  "functions": {
    "api/heavy.js": { "maxDuration": 30 }
  }
}
```

---

## 15. Anti-pattern (jangan dilakukan)

| Jangan | Kenapa |
|---|---|
| `setInterval` / cron di dalam handler | Function mati setelah response — interval tidak akan jalan |
| Long-lived WebSocket server di `/api/` | Function timeout 10 dtk untuk hobby; pakai eksternal (Ably, Pusher, Supabase Realtime) |
| Cache result di module-level `Map` untuk waktu lama | Cold start = cache hilang; pakai Redis (Upstash) atau DB |
| Connect ke MongoDB tanpa cache | Setiap request: 200-500ms latency wasted di TLS handshake |
| `mongoose.model('X', schema)` tanpa guard | `OverwriteModelError` saat module re-import |
| Heavy compute di handler (>5 dtk) | Mendekati timeout, user perceives lag; pakai background queue (Inngest, Trigger.dev) |
| Pakai filesystem write di `/tmp` untuk persist | Filesystem ephemeral — hilang setelah function selesai |
| Forget `await` di async operation | Response terkirim sebelum operation selesai → silent fail di logs |

---

## 16. Migrasi dari Express ke Vercel — step-by-step

Skenario: Anda punya `server/index.js` Express monolith, mau pindah ke Vercel.

### Step 1 — Identifikasi handler

Tiap `app.get('/api/X', ...)` jadi calon file `api/X.js`.

```js
// Sebelum: server/index.js
app.get('/api/settings', async (req, res) => {
  const doc = await Settings.findById('global').lean()
  res.json(doc ?? {})
})
```

### Step 2 — Ekstrak schema ke shared module

```js
// api/_lib/models.js
import mongoose from 'mongoose'
function defineModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema)
}
const settingsSchema = new mongoose.Schema({ /* ... */ })
export const Settings = defineModel('Settings', settingsSchema)
```

### Step 3 — Ekstrak connection logic ke shared module

Lihat §5 — `api/_lib/mongo.js`.

### Step 4 — Konversi handler

```js
// api/settings.js
import { connectMongo } from './_lib/mongo.js'
import { Settings } from './_lib/models.js'

export default async function handler(req, res) {
  try {
    await connectMongo()

    if (req.method === 'GET') {
      const doc = await Settings.findById('global').lean()
      return res.status(200).json(doc ?? {})
    }

    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
```

### Step 5 — Refactor server/index.js jadi wrapper

Lihat §8.

### Step 6 — Setup vercel.json + .vercelignore

Lihat §9 + §10.

### Step 7 — Hapus deployment artifacts lama

```
Dockerfile
.dockerignore
fly.toml
docker-compose.yml
.do/app.yaml          ← DigitalOcean
render.yaml           ← Render
railway.toml          ← Railway
```

### Step 8 — Test lokal sebelum deploy

```bash
npm run dev                                    # Frontend + Express wrapper
curl http://localhost:5173/api/health          # via vite proxy
curl http://localhost:5173/api/settings
```

### Step 9 — Set env var di Vercel + deploy

```bash
vercel env add MONGO_URI production
git push origin main
```

### Step 10 — Verifikasi production

```bash
curl https://<project>.vercel.app/api/health   # → {"ok":true,"ts":...}
```

Buka frontend di browser → cek `Network` tab → semua `/api/*` request balik 200.

---

## 17. Troubleshooting

### `MongoServerError: bad auth`

- Username/password salah di `MONGO_URI`
- Character spesial belum di-URL-encode: `@` → `%40`, `:` → `%3A`, `/` → `%2F`

### `MongoNetworkError: connection timed out`

- Atlas IP allow list belum termasuk `0.0.0.0/0`
- Connection string typo (host name)
- Atlas cluster di-pause (free tier auto-pause kalau idle 7 hari)

### Function bundle terlalu besar (>50 MB)

- Cek dependencies: `du -sh node_modules/* | sort -hr | head -20`
- Buang lib yang tidak dipakai server-side dari `dependencies` (pindah ke `devDependencies`)
- Common offenders: `puppeteer` (300 MB), `tensorflow` (700 MB), `playwright` (500 MB)

### `OverwriteModelError: Cannot overwrite 'X' model`

- Definisi schema tanpa guard `mongoose.models[name] || mongoose.model(...)` — lihat §6

### Function timeout (10 dtk)

- Cold start mongoose connect makan ~3-5 dtk → query kompleks bisa timeout
- Solusi: tingkatkan `serverSelectionTimeoutMS` saat connect, atau pakai query yang lebih efisien (proper index)
- Atau pisah query berat ke background job

### Same-origin tapi tetap kena CORS

- Pastikan tidak ada `app.use(cors())` di handler — duplikasi header bisa malah block
- Vercel serverless tidak butuh CORS sama sekali untuk `/api/*` calls dari frontend yang sama

---

## 18. Checklist port ke proyek SCADA lain

- [ ] Identifikasi semua handler Express → ekstrak ke `api/*.js`
- [ ] Buat `api/_lib/mongo.js` dengan connection cache (§5)
- [ ] Buat `api/_lib/models.js` dengan `defineModel` guard (§6)
- [ ] Konversi handler ke signature `export default async function handler(req, res)` (§4, §7)
- [ ] Buat `server/index.js` wrapper tipis untuk local dev (§8) — opsional
- [ ] Buat `vercel.json` minimum (§9)
- [ ] Buat `.vercelignore` (§10)
- [ ] Hapus `Dockerfile`, `fly.toml`, dll
- [ ] Set `MONGO_URI` di Vercel dashboard (§11)
- [ ] Atlas Network Access → `0.0.0.0/0` (§12)
- [ ] Test lokal: `npm run dev` + `curl /api/health`
- [ ] Deploy: `git push` atau `vercel --prod` (§13)
- [ ] Verifikasi production endpoints (§16 step 10)

---

## 19. File yang relevan di repo ini

| File | Pattern yang dicontohkan |
|---|---|
| [api/_lib/mongo.js](api/_lib/mongo.js) | Connection cache via globalThis (§5) |
| [api/_lib/models.js](api/_lib/models.js) | Model redefinition guard (§6) |
| [api/health.js](api/health.js) | Handler sederhana tanpa DB |
| [api/settings.js](api/settings.js) | Multi-method handler (GET+POST) dengan DB (§7) |
| [api/telemetry.js](api/telemetry.js) | Bulk insert + query with aggregation pivoting |
| [server/index.js](server/index.js) | Express wrapper untuk local dev (§8) |
| [vercel.json](vercel.json) | Konfigurasi minimum Vite project (§9) |
| [.vercelignore](.vercelignore) | Exclude rules (§10) |
| [vite.config.js](vite.config.js) | `/api` proxy ke Express dev server |
