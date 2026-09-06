# ADR 0005: Project runtime worker lifecycle modes

- Status: Accepted
- Date: 2026-09-06

## Context

The Isaac rollout control exposed an experimental stream decision to ordinary
runtime administration and produced inconsistent behavior across restarts. The
Windows Service must remain available, but keeping every project datasource hot
is not always the right resource or operational policy.

## Decision

Replace the Builder's Isaac rollout setup with one audited lifecycle setting per
project: `smart`, `always-on`, or `on-demand`. The protected Windows Service and
managed Node supervisor remain running in every mode. Only connector runtimes
that possess an enabled connector, configured secret, and valid selected schema
can be started.

`smart` is the backward-compatible default. Published selections and projects
with active runtime sessions stay connected. Draft bootstrap connections remain
warm for 30 minutes after their last save and then rest. `always-on` keeps every
eligible project connector alive. `on-demand` requires an unexpired runtime
session; creating a session sends a best-effort private IPC wake signal and the
ten-second reconciliation loop remains authoritative.

Only workspace administrators can change the setting. Changes are persisted on
the project, normalized fail-closed to `smart`, and recorded as
`project.runtime-worker-mode.updated` with only the previous and new modes.

## Safety boundaries

- Worker mode never enables Isaac or changes the published runtime profile.
- Disabled connectors, missing secrets, and invalid schemas never start.
- Existing bounded reconnect, command queue, shutdown, and recovery policies
  remain authoritative.
- On-demand activity is derived from server-side revocable runtime sessions,
  not a client-provided online flag.
- A failed IPC wake cannot change policy; periodic MongoDB reconciliation starts
  or stops the connector deterministically.

## Rollback

Remove the project field or set it to `smart`. Legacy and invalid values already
resolve to `smart`, so no database migration or published-version rewrite is
required.
