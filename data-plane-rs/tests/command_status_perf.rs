use axum::extract::ws::Utf8Bytes;
use scamatic_data_plane::gateway::encode_command_status;
use serde_json::{Value, json};
use std::hint::black_box;
use std::time::Instant;

const CLIENTS: usize = 16;
const ITERATIONS: usize = 10_000;

#[test]
#[ignore = "repeatable local command-status fan-out benchmark"]
fn command_status_fanout_benchmark() {
    let command = fixture_command();
    for _ in 0..100 {
        black_box(legacy_fanout(&command));
        black_box(preencoded_fanout(&command));
    }

    let legacy_started = Instant::now();
    let mut legacy_bytes = 0;
    for _ in 0..ITERATIONS {
        legacy_bytes += black_box(legacy_fanout(&command));
    }
    let legacy_elapsed = legacy_started.elapsed();

    let optimized_started = Instant::now();
    let mut optimized_bytes = 0;
    for _ in 0..ITERATIONS {
        optimized_bytes += black_box(preencoded_fanout(&command));
    }
    let optimized_elapsed = optimized_started.elapsed();

    assert_eq!(optimized_bytes, legacy_bytes);
    println!(
        "command-status-benchmark legacy_ms={:.3} optimized_ms={:.3} speedup={:.2}x clients={} iterations={} encoded_bytes={}",
        legacy_elapsed.as_secs_f64() * 1_000.0,
        optimized_elapsed.as_secs_f64() * 1_000.0,
        legacy_elapsed.as_secs_f64() / optimized_elapsed.as_secs_f64(),
        CLIENTS,
        ITERATIONS,
        legacy_bytes,
    );
}

fn legacy_fanout(command: &Value) -> usize {
    let mut bytes = 0;
    for _ in 0..CLIENTS {
        let frame = json!({ "type": "command-status", "command": command }).to_string();
        bytes += black_box(frame.len());
    }
    bytes
}

fn preencoded_fanout(command: &Value) -> usize {
    let frame = encode_command_status(command).unwrap();
    let mut bytes = 0;
    for _ in 0..CLIENTS {
        let shared: Utf8Bytes = black_box(frame.clone());
        bytes += black_box(shared.len());
    }
    bytes
}

fn fixture_command() -> Value {
    json!({
        "requestId": "request-0123456789",
        "componentId": "valve-open",
        "tagId": "valve-command",
        "status": "acknowledged",
        "message": "Command acknowledged.",
        "result": { "value": true, "receipt": "TWO_WAY_RPC_ACK" },
        "timing": {
            "workerQueueMs": 3,
            "gatewayRpcMs": 41,
            "terminalProcessingMs": 2,
            "serverTotalMs": 49
        }
    })
}
