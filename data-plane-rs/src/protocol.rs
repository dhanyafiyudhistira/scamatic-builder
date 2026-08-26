use crate::state::ShadowState;
use serde::Deserialize;
use serde_json::Value;

pub const CONTROL_SOURCE: &str = "scamatic-control-plane";
pub const OUTPUT_SOURCE: &str = "scamatic-rust-data-plane";
pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_LINE_BYTES: usize = 1_048_576;
const MAX_EVENTS_PER_BATCH: usize = 20_000;
const MAX_IDENTIFIER_BYTES: usize = 160;

#[derive(Debug, PartialEq, Eq)]
pub enum ControlFlow {
    Continue,
    Shutdown,
}

#[derive(Debug, Deserialize)]
struct Envelope {
    source: String,
    version: u8,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    payload: Value,
}

pub fn handle_line(line: &str, state: &ShadowState) -> Result<ControlFlow, &'static str> {
    if line.len() > MAX_LINE_BYTES {
        state.record_rejected();
        return Err("FRAME_TOO_LARGE");
    }
    let envelope: Envelope = serde_json::from_str(line).map_err(|_| {
        state.record_rejected();
        "INVALID_JSON"
    })?;
    if envelope.source != CONTROL_SOURCE || envelope.version != PROTOCOL_VERSION {
        state.record_rejected();
        return Err("INVALID_PROTOCOL");
    }

    match envelope.kind.as_str() {
        "shadow.telemetry.batch" => {
            let events = envelope
                .payload
                .get("events")
                .and_then(Value::as_array)
                .ok_or_else(|| reject(state, "INVALID_TELEMETRY_BATCH"))?;
            if events.len() > MAX_EVENTS_PER_BATCH
                || events.iter().any(|event| {
                    !valid_identifier(event, "workspaceId")
                        || !valid_identifier(event, "projectId")
                        || !valid_identifier(event, "tagId")
                        || event.get("receivedAt").and_then(Value::as_str).is_none()
                })
            {
                state.record_rejected();
                return Err("INVALID_TELEMETRY_BATCH");
            }
            let dropped = envelope
                .payload
                .get("dropped")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            state.record_telemetry(events.len() as u64, dropped);
            Ok(ControlFlow::Continue)
        }
        "shadow.command.status" => {
            let event = envelope
                .payload
                .get("event")
                .ok_or_else(|| reject(state, "INVALID_COMMAND_STATUS"))?;
            if !valid_identifier(event, "requestId")
                || !valid_identifier(event, "componentId")
                || !valid_identifier(event, "status")
            {
                state.record_rejected();
                return Err("INVALID_COMMAND_STATUS");
            }
            state.record_command();
            Ok(ControlFlow::Continue)
        }
        "control.ping" => Ok(ControlFlow::Continue),
        "control.shutdown" => Ok(ControlFlow::Shutdown),
        _ => {
            state.record_rejected();
            Err("UNSUPPORTED_MESSAGE")
        }
    }
}

fn valid_identifier(value: &Value, field: &str) -> bool {
    value
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty() && text.len() <= MAX_IDENTIFIER_BYTES)
}

fn reject(state: &ShadowState, code: &'static str) -> &'static str {
    state.record_rejected();
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_shadow_frames_update_observation_counters() {
        let state = ShadowState::new();
        let telemetry = r#"{"source":"scamatic-control-plane","version":1,"type":"shadow.telemetry.batch","payload":{"events":[{"workspaceId":"w","projectId":"p","tagId":"t","receivedAt":"2026-08-25T00:00:00Z","value":42}],"dropped":2}}"#;
        let command = r#"{"source":"scamatic-control-plane","version":1,"type":"shadow.command.status","payload":{"event":{"requestId":"r","componentId":"c","status":"dispatched"}}}"#;
        assert_eq!(handle_line(telemetry, &state), Ok(ControlFlow::Continue));
        assert_eq!(handle_line(command, &state), Ok(ControlFlow::Continue));
        let snapshot = state.snapshot();
        assert_eq!(snapshot.telemetry_batches, 1);
        assert_eq!(snapshot.telemetry_events, 1);
        assert_eq!(snapshot.command_events, 1);
        assert_eq!(snapshot.upstream_dropped, 2);
        assert_eq!(snapshot.rejected_frames, 0);
    }

    #[test]
    fn foreign_and_malformed_frames_are_rejected_without_side_effects() {
        let state = ShadowState::new();
        let foreign = r#"{"source":"foreign","version":1,"type":"control.ping","payload":{}}"#;
        let malformed = r#"{"source":"scamatic-control-plane","version":1,"type":"shadow.telemetry.batch","payload":{"events":[{}]}}"#;
        assert_eq!(handle_line(foreign, &state), Err("INVALID_PROTOCOL"));
        assert_eq!(
            handle_line(malformed, &state),
            Err("INVALID_TELEMETRY_BATCH")
        );
        let snapshot = state.snapshot();
        assert_eq!(snapshot.telemetry_events, 0);
        assert_eq!(snapshot.rejected_frames, 2);
    }

    #[test]
    fn shutdown_is_an_explicit_control_message() {
        let state = ShadowState::new();
        let shutdown = r#"{"source":"scamatic-control-plane","version":1,"type":"control.shutdown","payload":{}}"#;
        assert_eq!(handle_line(shutdown, &state), Ok(ControlFlow::Shutdown));
    }
}
