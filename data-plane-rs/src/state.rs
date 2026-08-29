use crate::gateway::{CommandScope, IsaacGateway};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub struct ShadowState {
    started_at: Instant,
    ready: AtomicBool,
    telemetry_batches: AtomicU64,
    telemetry_events: AtomicU64,
    command_events: AtomicU64,
    rejected_frames: AtomicU64,
    upstream_dropped: AtomicU64,
    last_event_at_ms: AtomicU64,
    gateway: Option<Arc<IsaacGateway>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowSnapshot {
    pub ok: bool,
    pub status: &'static str,
    pub mode: &'static str,
    pub active: bool,
    pub uptime_seconds: u64,
    pub telemetry_batches: u64,
    pub telemetry_events: u64,
    pub command_events: u64,
    pub rejected_frames: u64,
    pub upstream_dropped: u64,
    pub last_event_at_ms: u64,
    pub gateway_ready: bool,
    pub gateway_clients: u64,
    pub gateway_auth_failures: u64,
    pub gateway_lagged_clients: u64,
    pub gateway_delivered_events: u64,
}

impl ShadowState {
    pub fn new() -> Self {
        Self::with_gateway(None)
    }

    pub fn with_gateway(gateway: Option<Arc<IsaacGateway>>) -> Self {
        Self {
            started_at: Instant::now(),
            ready: AtomicBool::new(false),
            telemetry_batches: AtomicU64::new(0),
            telemetry_events: AtomicU64::new(0),
            command_events: AtomicU64::new(0),
            rejected_frames: AtomicU64::new(0),
            upstream_dropped: AtomicU64::new(0),
            last_event_at_ms: AtomicU64::new(0),
            gateway,
        }
    }

    pub fn gateway(&self) -> Option<Arc<IsaacGateway>> {
        self.gateway.clone()
    }

    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::Relaxed);
    }

    pub fn record_telemetry(&self, events: u64, upstream_dropped: u64) {
        self.telemetry_batches.fetch_add(1, Ordering::Relaxed);
        self.telemetry_events.fetch_add(events, Ordering::Relaxed);
        self.upstream_dropped
            .fetch_add(upstream_dropped, Ordering::Relaxed);
        self.touch();
    }

    pub fn record_command(&self) {
        self.command_events.fetch_add(1, Ordering::Relaxed);
        self.touch();
    }

    pub fn publish_telemetry(&self, events: Vec<Value>) {
        if let Some(gateway) = &self.gateway {
            gateway.publish_telemetry(events);
        }
    }

    pub fn publish_command(&self, event: Value, scope: CommandScope) {
        if let Some(gateway) = &self.gateway {
            gateway.publish_command(event, scope);
        }
    }

    pub fn record_rejected(&self) {
        self.rejected_frames.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> ShadowSnapshot {
        let ready = self.ready.load(Ordering::Relaxed);
        let gateway = self
            .gateway
            .as_ref()
            .map(|gateway| gateway.counters())
            .unwrap_or_default();
        let gateway_ready = ready && self.gateway.is_some();
        ShadowSnapshot {
            ok: ready,
            status: if ready { "ready" } else { "not-ready" },
            mode: if gateway_ready {
                "isaac-canary"
            } else {
                "shadow"
            },
            active: gateway_ready,
            uptime_seconds: self.started_at.elapsed().as_secs(),
            telemetry_batches: self.telemetry_batches.load(Ordering::Relaxed),
            telemetry_events: self.telemetry_events.load(Ordering::Relaxed),
            command_events: self.command_events.load(Ordering::Relaxed),
            rejected_frames: self.rejected_frames.load(Ordering::Relaxed),
            upstream_dropped: self.upstream_dropped.load(Ordering::Relaxed),
            last_event_at_ms: self.last_event_at_ms.load(Ordering::Relaxed),
            gateway_ready,
            gateway_clients: gateway.clients,
            gateway_auth_failures: gateway.auth_failures,
            gateway_lagged_clients: gateway.lagged_clients,
            gateway_delivered_events: gateway.delivered_events,
        }
    }

    pub fn metrics(&self) -> String {
        let snapshot = self.snapshot();
        format!(
            concat!(
                "# TYPE scamatic_shadow_ready gauge\n",
                "scamatic_shadow_ready {}\n",
                "# TYPE scamatic_shadow_telemetry_batches_total counter\n",
                "scamatic_shadow_telemetry_batches_total {}\n",
                "# TYPE scamatic_shadow_telemetry_events_total counter\n",
                "scamatic_shadow_telemetry_events_total {}\n",
                "# TYPE scamatic_shadow_command_events_total counter\n",
                "scamatic_shadow_command_events_total {}\n",
                "# TYPE scamatic_shadow_rejected_frames_total counter\n",
                "scamatic_shadow_rejected_frames_total {}\n",
                "# TYPE scamatic_shadow_upstream_dropped_total counter\n",
                "scamatic_shadow_upstream_dropped_total {}\n",
                "# TYPE scamatic_isaac_gateway_ready gauge\n",
                "scamatic_isaac_gateway_ready {}\n",
                "# TYPE scamatic_isaac_gateway_clients gauge\n",
                "scamatic_isaac_gateway_clients {}\n",
                "# TYPE scamatic_isaac_gateway_auth_failures_total counter\n",
                "scamatic_isaac_gateway_auth_failures_total {}\n",
                "# TYPE scamatic_isaac_gateway_lagged_clients_total counter\n",
                "scamatic_isaac_gateway_lagged_clients_total {}\n",
                "# TYPE scamatic_isaac_gateway_delivered_events_total counter\n",
                "scamatic_isaac_gateway_delivered_events_total {}\n"
            ),
            u8::from(snapshot.ok),
            snapshot.telemetry_batches,
            snapshot.telemetry_events,
            snapshot.command_events,
            snapshot.rejected_frames,
            snapshot.upstream_dropped,
            u8::from(snapshot.gateway_ready),
            snapshot.gateway_clients,
            snapshot.gateway_auth_failures,
            snapshot.gateway_lagged_clients,
            snapshot.gateway_delivered_events,
        )
    }

    fn touch(&self) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0);
        self.last_event_at_ms.store(timestamp, Ordering::Relaxed);
    }
}

impl Default for ShadowState {
    fn default() -> Self {
        Self::new()
    }
}
