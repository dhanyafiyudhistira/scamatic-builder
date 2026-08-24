# ADR 0001: Connector platform boundary

- Status: Accepted
- Date: 2026-07-21

## Context

The legacy UI opens a ThingsBoard telemetry socket in the browser and stores
its JWT through `/api/settings`. That makes credentials browser-visible and
couples the runtime to one vendor. Serverless request handlers also cannot own
a reliable, long-lived industrial connection.

## Decision

The connector platform has three boundaries:

1. The existing HTTP API is the control plane. It owns connector metadata,
   encrypted environment secrets, RBAC, audit, test requests, and publish
   gates.
2. `server/connector-worker.js` is a separately deployed, long-lived Node.js
   worker. Drivers connect upstream and emit only normalized tag events.
3. Published runtimes connect to the worker with a short-lived, project- and
   version-scoped stream ticket. Vendor identifiers and credentials never
   enter the runtime payload.

The first driver is ThingsBoard. Secrets use AES-256-GCM envelope encryption
with the wrapping key supplied as `SCADA_CONNECTOR_MASTER_KEY`. The initial
environment is `staging`; connector and live-command flags default to off.

Commands move through `requested -> authorized -> dispatched ->
accepted_by_gateway -> acknowledged|rejected|timeout|failed`. A successful
one-way HTTP RPC is not a PLC acknowledgment. ThingsBoard commands must use a
two-way RPC response or a configured feedback tag/value.

The mock connector remains available and the `/legacy` UI is unchanged.

## Consequences

- The worker must be hosted on a persistent Node.js service, not a Vercel
  function.
- Adding MQTT, OPC UA, or Modbus requires a driver implementation, not changes
  to `RuntimeCanvas`.
- Existing schema 1.0.0, 1.1.0, and 1.2.0 drafts are migrated in memory to
  1.3.0 when opened or published. Control Pop-up membership is stored as component ID
  references, so its Button and Slider children retain their normal bindings
  and command behavior; plaintext legacy settings are deliberately not
  migrated.
- Periodic tag freshness uses a bounded rolling interval while event-driven
  tags rely on connector state and fresh samples instead of operator activity.
