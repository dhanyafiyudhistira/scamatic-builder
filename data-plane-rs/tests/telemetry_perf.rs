use scamatic_data_plane::telemetry::{
    SharedTelemetryBatch, TelemetryBatchPayload, encode_scoped_telemetry,
};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::hint::black_box;
use std::sync::Arc;
use std::time::Instant;

const EVENTS: usize = 1_000;
const CLIENTS: usize = 16;
const ITERATIONS: usize = 50;

#[test]
#[ignore = "repeatable local telemetry pipeline benchmark"]
fn telemetry_pipeline_benchmark() {
    let frame = fixture_frame(EVENTS);
    let allowed = allowed_tags(EVENTS / 2);
    for _ in 0..5 {
        black_box(legacy_pipeline(&frame, &allowed));
    }
    let started = Instant::now();
    let mut delivered = 0;
    let mut bytes = 0;
    for _ in 0..ITERATIONS {
        let result = black_box(legacy_pipeline(&frame, &allowed));
        delivered += result.0;
        bytes += result.1;
    }
    let elapsed = started.elapsed();
    assert_eq!(delivered, ITERATIONS * CLIENTS * (EVENTS / 2));

    for _ in 0..5 {
        black_box(optimized_pipeline(&frame, &allowed));
    }
    let optimized_started = Instant::now();
    let mut optimized_delivered = 0;
    let mut optimized_bytes = 0;
    for _ in 0..ITERATIONS {
        let result = black_box(optimized_pipeline(&frame, &allowed));
        optimized_delivered += result.0;
        optimized_bytes += result.1;
    }
    let optimized_elapsed = optimized_started.elapsed();
    assert_eq!(optimized_delivered, delivered);
    assert_eq!(optimized_bytes, bytes);
    println!(
        "telemetry-benchmark legacy_ms={:.3} optimized_ms={:.3} speedup={:.2}x events={} clients={} iterations={} encoded_bytes={}",
        elapsed.as_secs_f64() * 1_000.0,
        optimized_elapsed.as_secs_f64() * 1_000.0,
        elapsed.as_secs_f64() / optimized_elapsed.as_secs_f64(),
        EVENTS,
        CLIENTS,
        ITERATIONS,
        bytes,
    );
}

#[derive(Deserialize)]
struct BorrowedEnvelope<'a> {
    #[serde(borrow)]
    payload: &'a RawValue,
}

fn optimized_pipeline(frame: &str, allowed: &HashSet<String>) -> (usize, usize) {
    let envelope: BorrowedEnvelope<'_> = serde_json::from_str(frame).unwrap();
    let payload: TelemetryBatchPayload = serde_json::from_str(envelope.payload.get()).unwrap();
    let events: SharedTelemetryBatch = Arc::from(payload.events);
    let mut delivered = 0;
    let mut bytes = 0;
    for _ in 0..CLIENTS {
        let encoded = encode_scoped_telemetry(events.as_ref(), "workspace-a", "project-a", allowed)
            .unwrap()
            .unwrap();
        delivered += encoded.events;
        bytes += encoded.text.len();
    }
    (delivered, bytes)
}

fn legacy_pipeline(frame: &str, allowed: &HashSet<String>) -> (usize, usize) {
    let envelope: Value = serde_json::from_str(frame).unwrap();
    let events = envelope["payload"]["events"].as_array().unwrap().clone();
    let mut delivered = 0;
    let mut bytes = 0;
    for _ in 0..CLIENTS {
        let filtered = events
            .clone()
            .into_iter()
            .filter(|event| {
                event["workspaceId"] == "workspace-a"
                    && event["projectId"] == "project-a"
                    && event["tagId"]
                        .as_str()
                        .is_some_and(|tag| allowed.contains(tag))
            })
            .collect::<Vec<_>>();
        delivered += filtered.len();
        bytes += serde_json::to_vec(&json!({ "type": "tag-batch", "events": filtered }))
            .unwrap()
            .len();
    }
    (delivered, bytes)
}

fn fixture_frame(events: usize) -> String {
    let events = (0..events)
        .map(|index| {
            json!({
                "workspaceId": "workspace-a",
                "projectId": "project-a",
                "sourceId": "source-a",
                "tagId": format!("tag-{index}"),
                "value": index as f64 * 0.25,
                "dataType": "number",
                "sourceTimestamp": "2026-09-01T00:00:00.000Z",
                "receivedAt": "2026-09-01T00:00:00.010Z",
                "quality": "good",
                "sequence": index + 1,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "source": "scamatic-control-plane",
        "version": 1,
        "type": "shadow.telemetry.batch",
        "payload": { "events": events, "dropped": 0 },
    })
    .to_string()
}

fn allowed_tags(count: usize) -> HashSet<String> {
    (0..count).map(|index| format!("tag-{index}")).collect()
}
