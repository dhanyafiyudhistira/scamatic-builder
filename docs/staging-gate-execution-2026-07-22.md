# Staging gate execution report — 2026-07-22

## Scope and safety boundary

The local `.env` contains a remote MongoDB URI whose database name does not
clearly identify it as staging. Connector feature flags, the connector master
key, the public WSS URL, and the ThingsBoard allowlist are not configured.
Therefore this run deliberately performed no remote database mutation and no
live ThingsBoard command.

## Executed gates

| Gate | Result | Evidence |
|---|---|---|
| JavaScript syntax | PASS | All API, server, shared, script, and test `.js` files passed `node --check`. |
| Automated tests | PASS | 41 passed, 0 failed. |
| Production build | PASS | Vite production build completed. |
| Patch whitespace | PASS | `git diff --check` completed without an error. |
| Production dependency audit | PASS | Registry audit returned `No known vulnerabilities found`. |
| Control-plane boot | PASS | `/api/health` returned 200. |
| Connector route protection | PASS | `/api/connectors` exists and returned 401 without a session; no database mutation occurred. |
| Simulator authentication | PASS | Valid credential accepted; invalid credential rejected. |
| ThingsBoard telemetry | PASS | A real WebSocket connection to the standalone simulator received telemetry. |
| Two-way RPC | PASS | Simulator returned a definitive acknowledgment. |
| One-way RPC semantics | PASS | Gateway acceptance was not treated as device acknowledgment. |
| Quality lifecycle | PASS | `good -> stale -> disconnected -> good` was verified with the last value preserved. |
| Sequence behavior | PASS | Tag sequences remained unique and monotonic. |
| Feedback acknowledgment | PASS | Matching feedback acknowledged; mismatch timed out. |
| Reconnect core | PASS | Runtime recovered after a synthetic initial upstream failure. |
| Feature flag fail-closed | PASS | Worker refused to start when the connector platform flag was disabled. |
| Secret envelope/redaction | PASS | Encryption, wrong-AAD rejection, and public projection redaction tests passed. |
| Configured secret scan | PASS | The configured Mongo URI was not found in source, build output, tests, docs, scripts, or public assets. |
| Browser runtime vendor boundary | PASS | Runtime/platform sources contain no direct ThingsBoard WebSocket import or endpoint. |
| Legacy plaintext settings | PASS | Plaintext write is disabled and the response no longer contains a token field. |

## Hardening added during this run

- Added connector runtime tests for quality transitions, recovery, feedback
  acknowledgment, timeout, and reconnect.
- Added standalone ThingsBoard simulator verification and orchestration scripts.
- Added a non-mutating control-plane smoke test.
- Updated `body-parser` to patched version 1.20.6 after the first audit found
  low-severity advisory GHSA-v422-hmwv-36x6; the repeat audit was clean.

## Gates requiring a real staging environment

| Gate | Status | Required input/action |
|---|---|---|
| Staging Mongo/API deployment | BLOCKED | Provide a clearly isolated staging database and deployment URL. |
| Public runtime WSS | BLOCKED | Deploy the worker as a persistent service with valid TLS and `/runtime-stream` routing. |
| Live ThingsBoard read path | BLOCKED | Configure a staging-only device, hostname, telemetry mappings, and JWT through the write-only UI. |
| Publish heartbeat gate | BLOCKED | Requires API and worker using the same staging database and master key. |
| Worker restart recovery in deployment | BLOCKED | Requires control of the deployed worker service. |
| Cross-project stream isolation E2E | BLOCKED | Requires two staging projects and assigned VIEWER/OPERATOR accounts. |
| `/legacy` shadow comparison | BLOCKED | Requires live legacy and normalized runtimes observing the same device. |
| Live command replay/timeout/reject | BLOCKED | Requires an isolated actuator/gateway and OWNER/ADMIN staging account. |
| Browser storage/network inspection | BLOCKED | Requires an authenticated staging browser session. |
| Burst/load test | BLOCKED | Requires an agreed tag count, event rate, concurrent runtime count, and staging capacity. |
| 24-hour soak | BLOCKED | Requires the deployed environment to remain available for the monitoring window. |
| OPERATOR sign-off | BLOCKED | Must wait until every command and security gate above passes. |

## Current verdict

The local connector core and simulator gates pass. The system is ready to enter
read-only staging integration, but it is not yet eligible for staging sign-off
or production command enablement.
