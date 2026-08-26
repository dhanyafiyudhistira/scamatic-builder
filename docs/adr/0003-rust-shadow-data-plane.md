# ADR 0003: Rust shadow data-plane over private NDJSON IPC

- Status: Accepted
- Date: 2026-08-25

## Context

The self-hosted runtime already exposes the frontend, REST API, and runtime
WebSocket through one Express origin. Its active Node connector worker is
supervised over private process IPC. Moving RPC actuation directly to a new
runtime without production evidence would create duplicate-command and
rollback risk.

## Decision

Phase 2 adds `scamatic-data-plane`, a Rust/Tokio process with a private Axum
health and metrics listener bound to a dynamic loopback port. Express starts it
only when `SCADA_RUST_SHADOW_ENABLED=true` and mirrors two bounded event types:

- coalesced telemetry batches;
- operator-safe command lifecycle projections.

The transport is versioned newline-delimited JSON over child stdin/stdout.
Rust stdout is protocol-only and diagnostics use stderr. Express passes a
minimal environment allowlist, excluding MongoDB URIs, connector secrets, and
the connector master key.

## Safety boundaries

The Rust worker is observational only:

- it does not query or write MongoDB;
- it does not receive ThingsBoard credentials;
- it does not open a public port;
- it does not execute or acknowledge RPC;
- its readiness never gates the active Node worker;
- crashes use bounded restart backoff and cannot interrupt the active path.

Axum exposes `/health/live`, `/health/ready`, and `/metrics` on
`127.0.0.1:<dynamic>`. Express exposes the sanitized shadow status at
`/health/data-plane/shadow`; it does not proxy the private Axum routes.

## Rollback

Set `SCADA_RUST_SHADOW_ENABLED=false` and restart Express. No schema migration
or command-state repair is required because shadow mode owns no durable or
actuation state.

## Promotion gate

Rust cannot become an active telemetry or RPC executor until a later ADR
defines durable command leases, idempotency, credential delivery, canary
selection, and zero-duplicate-actuation acceptance criteria.
