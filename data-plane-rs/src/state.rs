use serde::Serialize;
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
}

impl ShadowState {
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
            ready: AtomicBool::new(false),
            telemetry_batches: AtomicU64::new(0),
            telemetry_events: AtomicU64::new(0),
            command_events: AtomicU64::new(0),
            rejected_frames: AtomicU64::new(0),
            upstream_dropped: AtomicU64::new(0),
            last_event_at_ms: AtomicU64::new(0),
        }
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

    pub fn record_rejected(&self) {
        self.rejected_frames.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> ShadowSnapshot {
        let ready = self.ready.load(Ordering::Relaxed);
        ShadowSnapshot {
            ok: ready,
            status: if ready { "ready" } else { "not-ready" },
            mode: "shadow",
            active: false,
            uptime_seconds: self.started_at.elapsed().as_secs(),
            telemetry_batches: self.telemetry_batches.load(Ordering::Relaxed),
            telemetry_events: self.telemetry_events.load(Ordering::Relaxed),
            command_events: self.command_events.load(Ordering::Relaxed),
            rejected_frames: self.rejected_frames.load(Ordering::Relaxed),
            upstream_dropped: self.upstream_dropped.load(Ordering::Relaxed),
            last_event_at_ms: self.last_event_at_ms.load(Ordering::Relaxed),
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
                "scamatic_shadow_upstream_dropped_total {}\n"
            ),
            u8::from(snapshot.ok),
            snapshot.telemetry_batches,
            snapshot.telemetry_events,
            snapshot.command_events,
            snapshot.rejected_frames,
            snapshot.upstream_dropped,
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
