use serde::ser::{SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::Arc;

pub type SharedTelemetryBatch = Arc<[TelemetryEvent]>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
    pub workspace_id: String,
    pub project_id: String,
    pub tag_id: String,
    pub received_at: String,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

impl TelemetryEvent {
    pub fn valid_scope(&self, max_identifier_bytes: usize) -> bool {
        valid_identifier(&self.workspace_id, max_identifier_bytes)
            && valid_identifier(&self.project_id, max_identifier_bytes)
            && valid_identifier(&self.tag_id, max_identifier_bytes)
    }

    pub fn matches_scope(
        &self,
        workspace_id: &str,
        project_id: &str,
        allowed_tags: &HashSet<String>,
    ) -> bool {
        self.workspace_id == workspace_id
            && self.project_id == project_id
            && allowed_tags.contains(&self.tag_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct TelemetryBatchPayload {
    pub events: Vec<TelemetryEvent>,
    #[serde(default)]
    pub dropped: u64,
}

#[derive(Debug)]
pub struct EncodedTelemetryBatch {
    pub text: String,
    pub events: usize,
}

#[derive(Serialize)]
struct TelemetryStreamFrame<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    events: ScopedTelemetryEvents<'a>,
}

struct ScopedTelemetryEvents<'a> {
    batch: &'a [TelemetryEvent],
    workspace_id: &'a str,
    project_id: &'a str,
    allowed_tags: &'a HashSet<String>,
    event_count: usize,
}

impl Serialize for ScopedTelemetryEvents<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.event_count))?;
        for event in self.batch.iter().filter(|event| {
            event.matches_scope(self.workspace_id, self.project_id, self.allowed_tags)
        }) {
            sequence.serialize_element(event)?;
        }
        sequence.end()
    }
}

pub fn encode_scoped_telemetry(
    batch: &[TelemetryEvent],
    workspace_id: &str,
    project_id: &str,
    allowed_tags: &HashSet<String>,
) -> Result<Option<EncodedTelemetryBatch>, serde_json::Error> {
    let event_count = batch
        .iter()
        .filter(|event| event.matches_scope(workspace_id, project_id, allowed_tags))
        .count();
    if event_count == 0 {
        return Ok(None);
    }
    let text = serde_json::to_string(&TelemetryStreamFrame {
        kind: "tag-batch",
        events: ScopedTelemetryEvents {
            batch,
            workspace_id,
            project_id,
            allowed_tags,
            event_count,
        },
    })?;
    Ok(Some(EncodedTelemetryBatch {
        text,
        events: event_count,
    }))
}

fn valid_identifier(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn typed_event_preserves_the_existing_wire_shape_and_unknown_safe_fields() {
        let source = json!({
            "workspaceId": "workspace-a",
            "projectId": "project-a",
            "sourceId": "source-a",
            "tagId": "tag-a",
            "receivedAt": "2026-09-01T00:00:00.000Z",
            "quality": "good",
            "value": 42,
            "sequence": 7,
        });
        let event: TelemetryEvent = serde_json::from_value(source.clone()).unwrap();
        assert_eq!(serde_json::to_value(event).unwrap(), source);
    }

    #[test]
    fn scoped_encoding_filters_without_cloning_whole_events() {
        let events = serde_json::from_value::<Vec<TelemetryEvent>>(json!([
            { "workspaceId": "workspace-a", "projectId": "project-a", "tagId": "tag-a", "receivedAt": "now", "value": 1 },
            { "workspaceId": "workspace-a", "projectId": "project-b", "tagId": "tag-a", "receivedAt": "now", "value": 2 },
            { "workspaceId": "workspace-a", "projectId": "project-a", "tagId": "tag-b", "receivedAt": "now", "value": 3 }
        ]))
        .unwrap();
        let encoded = encode_scoped_telemetry(
            &events,
            "workspace-a",
            "project-a",
            &HashSet::from(["tag-a".to_string()]),
        )
        .unwrap()
        .unwrap();
        assert_eq!(encoded.events, 1);
        let decoded: Value = serde_json::from_str(&encoded.text).unwrap();
        assert_eq!(decoded["type"], "tag-batch");
        assert_eq!(decoded["events"].as_array().unwrap().len(), 1);
        assert_eq!(decoded["events"][0]["value"], 1);
    }
}
