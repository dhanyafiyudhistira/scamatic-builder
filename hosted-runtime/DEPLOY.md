# SCADA / IoT runtime trial — engine 0.2.24

This package contains one published SCADA or IoT Dashboard and its private
runtime API. It does not contain the Builder/editor, desktop credentials, draft,
or a Windows service. Source publication and target deployment are separate.

## Before starting

Use Node.js 22 or later and an EMPTY, dedicated MongoDB Atlas database (or a
transaction-capable replica set). Do not use the Builder database. The target
requires its own email/password, connector credentials, and encryption key.
The desktop computer does not need to stay online after deployment.

In Builder, publish a SIMULATION, MONITOR ONLY or REAL PLC version, then choose File →
Export runtime · Node / Railway or Export runtime · Vercel. SCADA exports include
the exact published, sanitized SVG schematic plus referenced design images and
process components. A missing or changed schematic blocks export. The target
preserves the source project type and canvas; SCADA keeps its schematic layout.
SIMULATION receives the internal simulation policy. MONITOR ONLY and REAL PLC
receive the monitor-only deployment policy. Live data comes through ThingsBoard; this package
does not connect directly to an on-premises PLC or deploy a Node-RED flow.

Engine 0.2.17 preserves empty schema objects when storing publications. For older
publications, export can reconstruct the Builder's minimized empty component
metadata only when the exact original publication checksum matches. It never
rewrites the source record. If export still reports a checksum mismatch, save
and publish a new version with the updated Builder before exporting again.

1. Extract the ZIP. Run `npm ci --omit=dev`, then `npm run verify`.
2. Copy `.env.example` to `.env` for local testing, or configure the corresponding
   environment variables in your hosting dashboard. Never commit `.env`.
3. Set `MONGO_URI`, `APP_ORIGIN` (exact public HTTPS origin), `SCADA_ADMIN_EMAIL`,
   and `SCADA_ADMIN_PASSWORD` (10 or more characters). This creates a target
   OPERATOR for simulation or VIEWER for monitor-only on the first import. It does
   not migrate your desktop account. Target project/workspace roles follow the
   deployment policy when redeploying a different published profile.
4. When connectors are listed in `deployment.json`, set a fresh 32-byte hex
   `SCADA_CONNECTOR_MASTER_KEY`, `CONNECTOR_ALLOWED_HOSTS` to the ThingsBoard
   hostname(s), and `RUNTIME_THINGSBOARD_CREDENTIALS` to a JSON object:

   `{"CONNECTOR_ID":{"jwt":"TARGET_JWT","refreshToken":"TARGET_REFRESH_TOKEN"}}`

   Use the connector IDs listed in the package, or `CONNECTOR_ID:ENVIRONMENT`
   for multiple environments. A refresh token is optional; without it, a JWT
   must be rotated manually. Credentials are encrypted in the target database.
   Keep the master key stable between deploys. Existing refreshed JWTs are not
   overwritten on a normal redeploy. Credential rotation after initial import
   requires target administration; it is not provided by this trial UI.
5. If `pinRequired` is true, set a new six-digit `SCADA_RUNTIME_PIN`. Weak repeated
   digits/sequences are rejected. The desktop PIN is never copied.

## Internal simulation

SIMULATION supports both SCADA and IoT on Node/Railway and Vercel. Buttons,
sliders, manual/reset operation modes and operator-selected AUTO steps run
against simulated values. Commands require login, CSRF, a valid runtime session,
the target OPERATOR role and the source component's role/confirmation rules.
Command results and audit events are stored in the target database. Components
configured for ADMIN/OWNER access still require those roles; this trial account
does not override the source permissions.

Simulation needs only the target database, account, origin and optional project
PIN. ThingsBoard JWTs, device tokens, a master key and an edge gateway are not
required. Existing ThingsBoard source/tag mappings remain in the snapshot, but
connector credentials and upstream connections are not provisioned for this
policy. The ThingsBoard simulation bridge is not included in this trial.

Simulation advances in the browser while the runtime is open. Slider ramp
progress and AUTO timers stop when the browser closes; stored command results
are restored when reopening. A continuously running background simulator is
outside this package. Chart history is session-only unless archive storage is
configured on the target. Live PLC commands remain unavailable.

## Node server / Railway

Deploy this extracted directory using the Dockerfile, or use install command
`npm ci --omit=dev` and start command `npm start`. The server binds to `0.0.0.0`
and the provider's `PORT` (default 3000). Set readiness path `/health/ready`.
The first start provisions the dedicated database in a transaction. A successful
import is idempotent. Unrelated projects, accounts, or Builder drafts block the
first import instead of being overwritten.

Open the public URL and sign in with the target credentials. For a local HTTP
trial only, set `NODE_ENV=development` and `APP_ORIGIN=http://127.0.0.1:3000`.

Live monitor profiles use HTTP polling, just like the serverless profile.
Persistent telemetry workers/streaming are a later milestone. ThingsBoard may
continue recording upstream, but this package does not archive telemetry while
all dashboard browsers are closed. Chart archive is optional target configuration;
without it, history is session-only.

## Vercel export

Choose the Vercel export in Builder to receive `vercel.json` and the runtime API
function. Deploy the extracted directory; output directory is `dist`, build
command is `npm run verify`, and install command is `npm ci --omit=dev`.
Set all target environment variables before opening the URL. The first API call
performs the same import. Use `/api/health` to check provisioning and MongoDB.
Cold starts and upstream latency are part of this trial. Requests are bounded
by the function's 30-second duration. No WebSocket/worker beta is required.

## Trial checks

- Login, project PIN when enabled, layout, images, and live ThingsBoard values.
- For SCADA, check the published SVG, process equipment, pipe layout, alarms,
  and tag bindings against the published desktop runtime.
- Stop the desktop Builder and confirm the hosted dashboard still updates.
- Open `/api/draft`, `/api/publish`, `/api/signup`, or another project ID: access
  must fail. For monitor-only packages, POST `/api/commands` is unavailable.
- For SIMULATION, test a button, slider, manual/reset and selected AUTO steps;
  confirm commands are acknowledged as simulation and no upstream bridge runs.
- Disconnect/reconnect ThingsBoard and check stale/disconnected indicators.
- Restart the target and confirm the same project and accounts remain available.

This package does not provide automatic publish-to-host synchronization. Export
a new published version and redeploy to update. Keep the previous complete ZIP
for rollback; do not edit snapshot/checksum files manually. Target accounts,
secrets, and audit records are preserved on update. An incompatible package,
conflicting immutable version/asset, or missing configuration fails import.
After a newer version is activated, old function instances reject runtime reads
with `DEPLOYMENT_VERSION_CHANGED` until clients reconnect to the new deployment.

Netlify, automatic provider integration, live control RPC and multi-project
hosting are outside this trial. Checksums detect corruption, not publisher identity.
Successful local build does not prove a live provider deployment succeeded.
