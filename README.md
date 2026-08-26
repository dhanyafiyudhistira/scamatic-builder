# Scamatic Builder — Builder + Secure Runtime MVP

Schema-driven SCADA schematic builder built from the original WTP Mixer HMI.

## Implemented flow

1. Sign in to a private workspace using a revocable database session.
2. Create a SCADA project with a logical canvas.
3. Upload a self-contained SVG (maximum 5 MB). The server rejects scripts,
   event handlers, external resources, `foreignObject`, JavaScript URLs, and
   XML entities.
4. Create a mock boolean tag.
5. Add Indicator Lamp, Value Span, Control Button, Tuning Slider, Text Label,
   Chart, and Control Pop-up components through the shared registry.
6. Import Node-RED flow JSON into reviewed tags and suggested components, or
   create tags manually.
7. Bind typed mock tags and configure rules, formatting, thresholds, and
   command behavior.
8. Edit using drag/resize, grid snapping, zoom, layers, multi-select,
   lock/hide, copy/paste, duplicate, and undo/redo.
9. Preview the draft using mock values and permission-aware mock commands.
10. Autosave with optimistic revision checking and local crash recovery.
11. Publish an immutable, checksummed version with draft revision and idempotency protection.
12. Browse version history or restore an older snapshot as a new version.
13. Open the private runtime at `/runtime/{projectSlug}`.
14. Execute project-scoped commands through the server command gateway.
15. Review publish, rollback, security, and command events in the audit panel.
16. Optionally protect each project with a hashed six-digit security PIN.

Roles are `OWNER`, `ADMIN`, `EDITOR`, `OPERATOR`, and `VIEWER`. Runtime and
command access are resolved server-side from workspace and project membership.

Project PIN protection is enforced by the API across Builder and published
Runtime routes. Unlocks are scoped to the authenticated browser session, expire
after eight hours by default, and are revoked when the PIN changes or the auth
session ends. Configure the bounded unlock lifetime with
`SCADA_PROJECT_UNLOCK_SECONDS`. Users with project-management permission can
recover a forgotten PIN only after re-entering their account password; recovery
attempts are rate-limited and audited. The PIN is a secondary project gate and
does not replace workspace RBAC or project membership checks.

The original mixer HMI remains available at `/legacy`.

### Node-RED flow import and export

Builder → File → **Import flow JSON** parses an exported Node-RED flow
locally in the browser. The importer recognizes S7 endpoint variables,
ThingsBoard telemetry paths, S7 outputs, statically declared RPC methods, and
common Node-RED Dashboard nodes. It previews inferred data types, access modes,
and suggested Builder components before applying one undoable draft change.

Function-node JavaScript is never executed. Broker configuration, passwords,
tokens, and other credentials are not copied into the project schema. Re-import
uses source metadata and existing bindings to reuse tags and components instead
of duplicating them. Numeric control limits and any unresolved RPC mappings must
still be reviewed by the user before publishing.

Builder → File → **Export flow JSON** performs the reverse conversion and
downloads a deterministic Node-RED flow from the current draft. The generated
flow includes native MQTT telemetry/RPC nodes, S7 nodes when a tag contains a
verified `metadata.plcAddress`, common Node-RED Dashboard nodes, and a comment
containing a safe metadata subset for accurate re-import. Tags without a PLC
address use explicit template or TODO nodes instead of fabricated mappings.

Exported broker and S7 configuration uses environment placeholders. JWTs,
device tokens, account passwords, connector references, and arbitrary component
properties are never serialized. Configure the ThingsBoard device token and PLC
endpoint in Node-RED before deploying the flow.

## Local setup

Copy `.env.example` to `.env` and configure `MONGO_URI`. Local development has
an intentional fallback account when auth variables are omitted:

```text
email:    admin@scada.local
password: admin
```

Production does not enable a default password. The configured owner is
bootstrapped into MongoDB with a salted scrypt password hash on first login.
Set these variables:

```text
SCADA_ADMIN_EMAIL
SCADA_ADMIN_PASSWORD
SCADA_WORKSPACE_ID
APP_ORIGIN
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
VITE_GOOGLE_AUTH_URL
MONGO_URI
SCADA_CONNECTOR_MASTER_KEY
```

`VITE_GOOGLE_AUTH_URL` is the browser-visible Google OAuth start endpoint used
by the login button. `GOOGLE_REDIRECT_URI` must exactly match an authorized
redirect URI on the Google Web application client. The server validates OAuth
state and nonce, uses PKCE for the authorization-code exchange, verifies the
Google identity, and then creates the same revocable HttpOnly session used by
password login. Include a URL-encoded `next` query value for the final local
page after authentication; the Builder home is `?next=%2F`.

Register these exact callback URIs on the Google Web application client:

```text
https://scada-dhany-wtp.vercel.app/api/auth/callback/google
http://localhost:5173/api/auth/callback/google
```

Then run:

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Local API: `http://localhost:3001`

### Self-hosted single-origin runtime

The recommended self-hosted path exposes the frontend, REST API, and runtime
WebSocket from Express on one port. In `embedded` mode Express also supervises
the existing Node connector worker over private process IPC, so neither the
worker nor the Rust shadow data-plane needs a browser-facing port.

```powershell
npm run build
$env:APP_ORIGIN = 'http://127.0.0.1:3001'
$env:CONNECTOR_PLATFORM_ENABLED = 'true'
$env:CONNECTOR_EXECUTION_MODE = 'worker'
$env:CONNECTOR_STREAM_MODE = 'embedded'
$env:SERVE_STATIC_FRONTEND = 'true'
npm run start
```

The application is then available at `http://127.0.0.1:3001`, including
`/api/*` and `/runtime-stream`. Do not start `npm run dev:worker` in embedded
mode because Express already owns and supervises that child process. Existing
deployments can retain `CONNECTOR_STREAM_MODE=standalone`, port `3002`, and an
explicit `CONNECTOR_STREAM_PUBLIC_URL` while migrating.

The Node worker remains the sole active connector telemetry and RPC executor.
The private IPC boundary can additionally mirror sanitized events into the
Rust/Tokio/Axum shadow worker without changing command ownership or
acknowledgment semantics.

### Rust shadow data-plane (Phase 2)

Phase 2 compiles a real Rust worker that validates mirrored telemetry and
operator-safe command status, tracks counters, and exposes private Axum health
and Prometheus metrics on a dynamic `127.0.0.1` port. It never receives MongoDB
or connector credentials, never contacts ThingsBoard, and never performs an
actuation.

```powershell
npm run rust:test
npm run rust:build
$env:SCADA_RUST_SHADOW_ENABLED = 'true'
npm run start
```

Development automatically discovers `data-plane-rs/target/release` and then
`target/debug`. A packaged deployment can set `SCADA_RUST_SHADOW_BINARY` to an
absolute prebuilt binary path, so the eventual installer will not require a
Rust toolchain. Shadow readiness is available through Express at
`GET /health/data-plane/shadow`; the response also reports the private Axum
health URL and observation counters. Set `SCADA_RUST_SHADOW_ENABLED=false` to
roll back instantly to the Phase 1 Node-only behavior.

### Optional Caddy edge

Caddy is no longer required for local or LAN use. It remains useful for public
TLS and certificate management; the included `Caddyfile` simply forwards the
single Express origin, including WebSocket upgrades:

```powershell
caddy validate --config .\Caddyfile
caddy run --config .\Caddyfile
```

### MongoDB connection troubleshooting

`DATABASE_UNAVAILABLE` means the API could not establish a MongoDB connection;
it is not an invalid-login response. For an Atlas `mongodb+srv://` URI, a
`querySrv ECONNREFUSED` error indicates that the current DNS resolver, VPN, or
firewall is blocking the SRV lookup. Verify Atlas Network Access, try a DNS
resolver that supports SRV records, and confirm that corporate/VPN policy allows
MongoDB Atlas DNS and outbound database traffic. The API disables implicit
Mongoose buffering, so connectivity failures return HTTP 503 instead of an
unrelated query timeout.

Use `GET /api/health` as the API liveness probe and
`GET /api/health?check=readiness` as the database-backed readiness probe. The
embedded connector worker exposes `GET /health/data-plane/live` and
`GET /health/data-plane/ready` through Express. Standalone mode retains
`GET /health/live` and `GET /health/ready` on `CONNECTOR_STREAM_PORT`. The
optional Rust observer reports separately through
`GET /health/data-plane/shadow` and never gates active worker readiness. The
worker retries transient MongoDB startup failures
with bounded exponential backoff; tune it with
`CONNECTOR_MONGO_STARTUP_MAX_ATTEMPTS`, `CONNECTOR_MONGO_RETRY_INITIAL_MS`, and
`CONNECTOR_MONGO_RETRY_MAX_MS`. A max-attempt value of `0` keeps retrying while
the liveness probe remains available and readiness stays at HTTP 503.

The local/staging API also warms its MongoDB connection in the background after
the HTTP listener starts. Configure its bounded exponential retry with
`API_MONGO_STARTUP_MAX_ATTEMPTS`, `API_MONGO_RETRY_INITIAL_MS`, and
`API_MONGO_RETRY_MAX_MS`. The default max-attempt value is `0`, so a transient
cold-start outage does not require a second API restart; configuration errors
still fail fast and keep readiness at HTTP 503 until corrected. Set
`MONGO_READINESS_TIMEOUT_MS` to bound each readiness response while the
background connection attempt continues.

Published commands retain their terminal `ACKNOWLEDGED`, `REJECTED`, `TIMEOUT`,
or `FAILED` result in the runtime, including request and correlation IDs. If
the initial command request returns a non-terminal status, Runtime reconciles
it through the authenticated command-status endpoint before reporting success.

### Dedicated Chart telemetry database

Chart history uses a separate MongoDB time-series storage plane. An OWNER or
ADMIN can configure it from Builder → Chart storage. The connection URI is a
write-only field: the API envelope-encrypts it with
`SCADA_CONNECTOR_MASTER_KEY`, binds the ciphertext to the workspace, and never
returns the URI to Builder or Runtime. `CHART_MONGO_URI` remains an optional
server-managed fallback when no workspace configuration exists.

Use a telemetry-only MongoDB cluster; do not reuse `MONGO_URI` in production.
Set `CHART_MONGO_ALLOWED_HOSTS` to the approved telemetry hostname. The worker
writes numeric `good` samples in bounded batches, while the control database
continues to hold only the latest tag snapshot required by commands and runtime
status.

Every sample is partitioned by `workspaceId`, `projectId`, `sourceId`, and
`tagId`. MongoDB TTL retention is configured with
`CHART_MONGO_RETENTION_DAYS`. `CHART_MONGO_MAX_QUEUE` bounds worker memory if
the archive becomes unavailable; the live WebSocket stream remains active and
the runtime reports `ARCHIVE DEGRADED` instead of failing the board.

The API and worker need the same control-plane database and wrapping key so the
worker can reload workspace storage changes without a restart. Database
credentials remain server-side and are never written to a project schema or
returned to a runtime client. See
[ADR 0002](docs/adr/0002-chart-telemetry-storage.md).

## Verification

```bash
npm test
npm run build
npm run smoke:phase3 # requires the local API and configured MongoDB
```

## Architecture

- `shared/project-schema.js` — shared schema factory and publish validation.
- `shared/component-registry.js` — component registry and schema-safe defaults.
- `shared/control-popup.js` — Control Pop-up ownership, ordering, and cleanup helpers.
- `shared/runtime-evaluator.js` — safe structured rules, value formatting, and mock commands.
- `src/BuilderPlatform.jsx` — project home and visual editor.
- `src/platform/RuntimeCanvas.jsx` — renderer shared by builder preview and runtime.
- `src/runtime/RuntimeApp.jsx` — lightweight private runtime entry, scoped session, and command lifecycle.
- `src/platform/useEditorHistory.js` — transaction-aware undo/redo state.
- `api/projects.js` — project creation and listing.
- `api/draft.js` — draft load/save with revision conflict detection.
- `api/svg.js` — server-side SVG validation and asset persistence.
- `api/publish.js` — transactional/idempotent validation and immutable snapshots.
- `api/versions.js` — version history and restore-as-new-version.
- `api/runtime.js` — private active-version runtime endpoint.
- `api/runtime-session.js` — short-lived project/version-scoped runtime sessions.
- `api/commands.js` — server-side allowlisted mock command gateway with replay protection.
- `api/audit.js` — project audit query endpoint.
- `api/members.js` — workspace users, roles, and project assignments.
- `api/_lib/auth.js` — opaque revocable HttpOnly sessions and CSRF protection.
- `api/_lib/authorization.js` — centralized capability and project-scope resolver.
- `api/_lib/chart-telemetry-store.js` — isolated MongoDB time-series history store.
- `server/connectors/telemetry-batch-writer.js` — bounded non-blocking telemetry batches.

## ThingsBoard connector vertical slice

The connector platform now separates the HTTP control plane, encrypted secret
store, persistent worker, and normalized runtime stream. Schema 1.0.0, 1.1.0,
and 1.2.0 drafts are upgraded to 1.3.0 when opened or published. Schema 1.2.0
added Control Pop-up as a reference-based wrapper: Control Buttons and Tuning
Sliders remain normal components but can belong to one Pop-up and are
suppressed from the root runtime canvas while assigned. Schema 1.3.0 adds
bounded adaptive tag freshness. Periodic tags may learn healthy publish jitter
without expanding the stale threshold beyond three times its configured floor.
Event-driven tags remain quiet while the connector is online, become
disconnected with the connector, and return to good only after a fresh sample.
The legacy browser connector remains under `/legacy` for protocol comparison,
but `/api/settings` no longer stores or returns plaintext credentials by
default. A temporary, read-only compatibility bridge can be enabled with
`LEGACY_DIRECT_THINGSBOARD_ENABLED=true` while an existing `/legacy` HMI is
migrated. This intentionally preserves its browser-visible ThingsBoard token,
so it must not be treated as the final Builder/runtime architecture.

Builder connectors can use **Connect ThingsBoard** in the Data sources panel to
exchange an account login for an encrypted access/refresh token pair. The
password is used only for that exchange and is never persisted. Active worker
and serverless connectors refresh the JWT five minutes before expiry, coordinate
concurrent refreshes through a short MongoDB lease, and retry one unauthorized
upstream request after rotation. Existing manual JWT connectors remain
supported and can be upgraded through the same button. A manual JWT rotation
clears any older refresh token; automatic mode accepts access and refresh tokens
only as one replacement pair.

See [the architecture decision](docs/adr/0001-connector-platform.md) and [the
staging runbook](docs/runbooks/thingsboard-staging.md). The platform and live
commands are separate, default-off feature flags.

For this first slice, sanitized SVG assets are stored in MongoDB. Moving asset
content to object storage and integrating a managed OIDC identity provider
remain foundation work before a public production release. Real telemetry and
command connectors are intentionally deferred to Phase 4; Phase 3 uses the
server-side mock adapter.
