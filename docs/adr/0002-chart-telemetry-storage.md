# ADR 0002: Isolated Chart telemetry storage

- Status: Accepted
- Date: 2026-07-27

## Context

High-frequency telemetry has a different workload and retention lifecycle from
users, project drafts, published versions, command events, and audit records.
Writing full Chart history into the control-plane database can exhaust its
connections, storage, or I/O and make authentication and runtime authorization
unavailable.

Database credentials also cannot be placed in a component binding or project
schema because those documents are delivered to browser runtimes.

## Decision

Chart history uses a dedicated MongoDB storage plane. OWNER and ADMIN roles can
manage a workspace-level configuration in Builder; a server environment
configuration remains an optional fallback only when the workspace has no
stored configuration.

- Production rejects a Chart URI targeting the same MongoDB cluster as
  `MONGO_URI`, unless an explicit development-only escape hatch is enabled.
- Production requires a `mongodb+srv://` target whose hostname is present in
  `CHART_MONGO_ALLOWED_HOSTS`. Private or reserved targets are rejected unless
  explicitly approved.
- The connection URI is write-only. It is envelope-encrypted with AES-256-GCM,
  protected by `SCADA_CONNECTOR_MASTER_KEY`, and authenticated with
  workspace-bound additional data. Neither configuration reads nor runtime
  payloads return the URI.
- A stored workspace configuration—including an explicitly disabled one—takes
  precedence over the environment fallback. This prevents accidental
  cross-workspace routing.
- Samples use a MongoDB time-series collection with `timestamp` as its time
  field and an immutable metadata partition containing `workspaceId`,
  `projectId`, `sourceId`, and `tagId`.
- MongoDB TTL expiration enforces bounded retention.
- The connector worker queues only numeric samples with `good` quality and
  writes them in batches. The queue has a fixed maximum and drops the oldest
  archive samples under sustained backpressure, preserving live operation and
  recent data.
- Runtime history reads are bounded by tag count, time window, per-tag limit,
  and a total bootstrap point budget.
- Archive failure degrades to session-only Chart history. It does not terminate
  the connector stream or make the runtime board unavailable.
- Deleting a project attempts a scoped telemetry cleanup without exposing
  database identifiers or credentials to the client.

## Consequences

- The API and connector worker must receive the same control-plane
  `MONGO_URI` and `SCADA_CONNECTOR_MASTER_KEY`. The worker reloads stored
  workspace configurations periodically without a restart.
- OWNER and ADMIN roles see archive readiness and safe target metadata in
  Builder but never receive credentials. Runtime users receive only a bounded
  health summary.
- A storage outage can create bounded gaps in archived history. It does not
  apply backpressure to the live control path.
- Production capacity planning, backups, Atlas network access, and alerting for
  the telemetry cluster remain deployment responsibilities.
