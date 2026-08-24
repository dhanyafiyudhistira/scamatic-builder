# ThingsBoard staging runbook

## Deployment topology

Deploy the Vite frontend and control-plane API normally. Deploy
`npm run dev:worker` as a separate persistent Node.js service with a public WSS
endpoint routed to port 3002. Do not deploy the worker as a Vercel function.

For a Vercel-only deployment, set `CONNECTOR_EXECUTION_MODE=serverless`.
Commands then execute through the Vercel API and the authenticated runtime
polls ThingsBoard telemetry through `/api/runtime-telemetry`; no persistent
connector worker or public WSS endpoint is required. Keep connector JWTs
encrypted server-side. Use `CONNECTOR_EXECUTION_MODE=worker` for the persistent
streaming topology described below.

Required worker variables are `MONGO_URI`, `CONNECTOR_PLATFORM_ENABLED=true`,
`CONNECTOR_ENVIRONMENT=staging`, `SCADA_CONNECTOR_MASTER_KEY`, and
`CONNECTOR_STREAM_PORT`. The API additionally needs
`CONNECTOR_STREAM_PUBLIC_URL` and the same master key. Keep
`CONNECTOR_LIVE_COMMANDS_ENABLED=false` for the read-only gate.

Run exactly one persistent worker replica per connector environment. The worker
uses an in-process, per-connector command lane so one connector executes RPCs in
order while different connectors remain parallel; MongoDB's atomic claim still
prevents duplicate execution. Horizontal worker scaling requires a distributed
connector lease before adding replicas, otherwise command ordering across
replicas is not guaranteed. `CONNECTOR_COMMAND_MAX_PENDING` bounds the local
queue (default 200), and `CONNECTOR_COMMAND_SHUTDOWN_MS` bounds graceful waiting
for an active RPC (default 35000 ms). Commands canceled before claim remain
durably `authorized` for the next worker; an active command that outlives the
shutdown grace must remain unverified and must never be executed automatically.

Configure deployment probes against the worker stream port:

- Liveness: `GET /health/live`
- Readiness: `GET /health/ready`

Readiness remains HTTP 503 while the worker is retrying MongoDB or loading its
initial connector configuration. Transient database startup failures use
bounded exponential backoff. Keep
`CONNECTOR_MONGO_STARTUP_MAX_ATTEMPTS=0` for a persistent worker, then set
`CONNECTOR_MONGO_RETRY_INITIAL_MS` and `CONNECTOR_MONGO_RETRY_MAX_MS` according
to the platform restart policy. The API probes are `GET /api/health` and
`GET /api/health?check=readiness`.

For persistent Chart history, sign in as OWNER or ADMIN and configure Builder →
Chart storage. In production, add the telemetry cluster hostname to
`CHART_MONGO_ALLOWED_HOSTS`; the submitted `mongodb+srv://` URI must resolve to
a different cluster than `MONGO_URI`. `CHART_MONGO_*` variables remain an
optional deployment-managed fallback when no workspace configuration exists.
Confirm the Builder status becomes `ready` and the worker activates it within
one reload interval; if it reports degraded, live telemetry should continue
while the archive is repaired.

Generate the wrapping key with a cryptographically secure 32-byte generator and
store the base64 output in the deployment secret manager. Rotation currently
requires re-entering connector JWTs and the Chart storage URI because old
records are bound to the old wrapping key.

## Staging gate

1. Create the ThingsBoard connector in Builder and enter the JWT in the
   write-only field.
2. Test it, attach its source, map telemetry keys, save, and enable it.
3. Start the worker and confirm health becomes `online`. Before the first
   connector-backed publish, the worker may use the validated saved draft in
   `Draft bootstrap` mode. This mode subscribes only to read-capable tags and
   updates connector health; it does not persist/stream telemetry or dispatch
   commands.
4. Publish only after the connector readiness check passes.
5. Confirm the worker leaves `Draft bootstrap` mode after publish and uses the
   active immutable version, then verify runtime batches, timestamps, quality transitions, reconnect, and
   project isolation against the simulator.
6. Compare the normalized values with `/legacy` in shadow mode.
7. Configure either two-way RPC or a feedback tag for every control.
   A component-level feedback tag takes priority over the connector-wide
   two-way setting. Use this for valve, pump, and level controls that have real
   PLC telemetry readback.
8. Enable `CONNECTOR_LIVE_COMMANDS_ENABLED=true` only for OWNER/ADMIN staging
   accounts. Exercise duplicate IDs, timeout, mismatch, disconnect, and audit.
   Confirm every terminal result remains visible with a request ID and
   correlation ID, and that both IDs match the command audit event.
   A command acknowledgment timeout is an uncertain result and must be shown as
   `unverified/timeout`, never as success, failure, or connector `offline`.
   Connector `offline` is reserved for the heartbeat/liveness path.
9. Sign off before granting OPERATOR live commands.

## Persistent Node-RED RPC responder

Import and deploy `scada-alif.json` in the Node-RED service that remains active
independently from the RWTest browser UI. The flow uses one subscription to
`v1/devices/me/rpc/request/+`, validates the method and payload, and publishes a
correlated response to `v1/devices/me/rpc/response/<requestId>`.

After deployment:

1. Close only the RWTest browser UI; keep Node-RED running.
2. Execute V205 from the published runtime.
3. Confirm Node-RED receives `setM_manualV205`.
4. Confirm ThingsBoard receives the matching response topic.
5. Confirm V205 uses its `Valve_205` feedback tag and reaches acknowledged only
   after the telemetry readback matches.
6. Execute Auto, Manual, and Reset and confirm each request receives its
   correlated two-way RPC response; these commands have no process readback.
7. Stop Node-RED deliberately and confirm the same command terminates as
   `unverified/timeout` while connector liveness remains independently derived.
   Restart Node-RED and verify recovery without reopening RWTest.

The RPC response proves that Node-RED validated and accepted the request. For
actuators with process readback, the feedback tag remains the stronger terminal
acknowledgment because it proves the observed PLC state.

## Incident response

Set `CONNECTOR_LIVE_COMMANDS_ENABLED=false` first. Disable the affected
connector in Builder, rotate its ThingsBoard JWT, inspect connector health and
command audit events, then restart the worker. The mock source remains
available and does not require republishing existing mock-only projects.
