# ADR 0004: Isaac Axum WebSocket canary

- Status: Accepted
- Date: 2026-08-28

## Context

ADR 0003 introduced a Rust/Tokio observer while Node remained the active
connector data-plane. The next low-risk step is to evaluate Axum for browser
stream fan-out without moving telemetry ingestion, durable authorization, or
RPC execution.

## Decision

Projects retain two independent settings: the published runtime profile
controls behavior and safety, while `runtimeEnginePreference` selects the
preferred stream implementation. `isaac` is eligible only when the global
canary flag is enabled, a workspace administrator has explicitly enabled the
project's audited `isaacCanaryEnabled` setting, the Axum worker reports gateway
readiness, and a valid public WebSocket URL is configured. Otherwise the server
selects `standard` and reports `ISAAC_UNAVAILABLE`.

The packaged local installer enables global canary availability and binds Axum
to `127.0.0.1:3003`; project selection remains explicit and audited. Plain
`ws:` is permitted only for that exact loopback endpoint. Remote production
endpoints continue to require `wss:`. The post-install verifier treats a
shadow-only worker as incomplete and requires `active=true` plus
`gatewayReady=true`.

Axum consumes single-use tickets whose `RuntimeStreamSession.engine` is
`isaac`. It asks a private loopback-only Node endpoint to consume each ticket
and revalidates the resulting runtime session every five seconds by default.
Node checks the revocable auth session, workspace/project/version scope,
capabilities, active published version, and allowed tag ids in MongoDB.

The Rust process receives only sanitized live event projections over the
existing bounded NDJSON child-process channel. It filters every telemetry and
command-status event against the authorized session scope before fan-out.
Command-status frames are serialized once into reference-counted UTF-8 bytes;
each authorized client receives a cheap clone of the same immutable frame.

## Safety boundaries

- Node remains the sole ThingsBoard telemetry source and RPC executor.
- Isaac never receives MongoDB or connector credentials.
- Isaac binds only to loopback; the edge exposes `/isaac-stream`.
- Tickets cannot be consumed across engines and are valid only once.
- Revocation or scope changes close the socket on periodic revalidation.
- Disabling a project's canary flag invalidates its active Isaac sessions on
  the next revalidation and atomically restores its Standard preference.
- A lagged client is disconnected instead of receiving a silently incomplete
  stream.
- A failed Isaac connection requests a new Standard session; there is no
  mid-command executor failover.

## Rollback

Set `SCADA_ISAAC_CANARY_ENABLED=false` and restart Express. Existing project
preferences may remain `isaac`; new sessions automatically select Standard.
No schema rollback or command repair is required because Isaac owns no durable
or actuation state.

## Promotion gate

Broader rollout requires canary evidence for authorization failures, client
lag, reconnect rate, delivered-event parity, process restarts, and Standard
fallback. Moving telemetry ingestion or RPC execution to Rust requires a
separate ADR and durable exactly-once command controls.
