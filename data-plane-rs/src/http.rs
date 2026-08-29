use crate::gateway::{IsaacEvent, IsaacGateway, IsaacSession};
use crate::state::{ShadowSnapshot, ShadowState};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header::CONTENT_TYPE};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, watch};
use tokio::time::MissedTickBehavior;

pub fn router(state: Arc<ShadowState>) -> Router {
    let mut router = Router::new()
        .route("/health/live", get(liveness))
        .route("/health/ready", get(readiness))
        .route("/metrics", get(metrics));
    if state.gateway().is_some() {
        router = router.route("/isaac-stream", get(isaac_stream));
    }
    router.with_state(state)
}

pub async fn serve(
    listener: TcpListener,
    state: Arc<ShadowState>,
    mut shutdown: watch::Receiver<bool>,
) -> std::io::Result<()> {
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async move {
            while !*shutdown.borrow() {
                if shutdown.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
}

async fn liveness(State(state): State<Arc<ShadowState>>) -> Json<ShadowSnapshot> {
    let mut snapshot = state.snapshot();
    snapshot.ok = true;
    snapshot.status = "alive";
    Json(snapshot)
}

async fn readiness(State(state): State<Arc<ShadowState>>) -> impl IntoResponse {
    let snapshot = state.snapshot();
    let status = if snapshot.ok {
        axum::http::StatusCode::OK
    } else {
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(snapshot))
}

async fn metrics(State(state): State<Arc<ShadowState>>) -> impl IntoResponse {
    (
        [(
            CONTENT_TYPE,
            HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
        )],
        state.metrics(),
    )
}

#[derive(Deserialize)]
struct StreamQuery {
    ticket: Option<String>,
}

async fn isaac_stream(
    ws: WebSocketUpgrade,
    Query(query): Query<StreamQuery>,
    State(state): State<Arc<ShadowState>>,
    headers: HeaderMap,
) -> Response {
    let Some(gateway) = state.gateway() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !gateway.origin_allowed(origin) {
        gateway.record_auth_failure();
        return StatusCode::FORBIDDEN.into_response();
    }
    let ticket = query.ticket.unwrap_or_default();
    if ticket.len() < 20
        || ticket.len() > 200
        || !ticket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        gateway.record_auth_failure();
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .on_upgrade(move |socket| handle_isaac_socket(socket, gateway, ticket))
}

async fn handle_isaac_socket(mut socket: WebSocket, gateway: Arc<IsaacGateway>, ticket: String) {
    let Some(authorizer) = gateway.config.authorizer.clone() else {
        let _ = close_socket(&mut socket, 1011, "Isaac authorizer unavailable").await;
        return;
    };
    let Some(mut session) = authorizer.authorize(&ticket).await else {
        gateway.record_auth_failure();
        let _ = close_socket(&mut socket, 4401, "Invalid stream ticket").await;
        return;
    };
    let ready = json!({
        "type": "ready",
        "engine": "isaac",
        "projectId": session.project_id,
        "versionId": session.version_id,
        "expiresAt": session.expires_at,
    });
    if socket
        .send(Message::Text(ready.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    gateway.client_opened();
    let mut events = gateway.subscribe();
    let (mut sender, mut receiver) = socket.split();
    let mut allowed_tags = session
        .allowed_tag_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    let mut revalidate = tokio::time::interval(gateway.config.revalidate_every);
    revalidate.set_missed_tick_behavior(MissedTickBehavior::Skip);
    revalidate.tick().await;

    loop {
        tokio::select! {
            event = events.recv() => {
                match event {
                    Ok(IsaacEvent::Telemetry(batch)) => {
                        let filtered = filter_telemetry(&session, &allowed_tags, batch);
                        if filtered.is_empty() { continue; }
                        let delivered = filtered.len() as u64;
                        if send_json(&mut sender, json!({ "type": "tag-batch", "events": filtered })).await.is_err() { break; }
                        gateway.record_delivered(delivered);
                    }
                    Ok(IsaacEvent::Command { event, scope }) => {
                        if !session.can_receive_commands()
                            || scope.user_id != session.user_id
                            || scope.workspace_id != session.workspace_id
                            || scope.project_id != session.project_id
                            || scope.version_id != session.version_id
                        {
                            continue;
                        }
                        if send_json(&mut sender, json!({ "type": "command-status", "command": event })).await.is_err() { break; }
                        gateway.record_delivered(1);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        gateway.record_lagged();
                        let _ = sender.send(Message::Close(Some(CloseFrame { code: 1013, reason: "Stream receiver lagged".into() }))).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = revalidate.tick() => {
                let Some(validated) = authorizer.revalidate(&session.runtime_session_id).await else {
                    let _ = sender.send(Message::Close(Some(CloseFrame { code: 4401, reason: "Runtime session revoked".into() }))).await;
                    break;
                };
                if !session.same_scope(&validated) {
                    let _ = sender.send(Message::Close(Some(CloseFrame { code: 4403, reason: "Runtime scope changed".into() }))).await;
                    break;
                }
                session = validated;
                allowed_tags = session.allowed_tag_ids.iter().cloned().collect();
            }
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Ping(data))) => {
                        if sender.send(Message::Pong(data)).await.is_err() { break; }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
    gateway.client_closed();
}

fn filter_telemetry(
    session: &IsaacSession,
    allowed_tags: &HashSet<String>,
    events: Vec<Value>,
) -> Vec<Value> {
    events
        .into_iter()
        .filter(|event| {
            event.get("workspaceId").and_then(Value::as_str) == Some(session.workspace_id.as_str())
                && event.get("projectId").and_then(Value::as_str)
                    == Some(session.project_id.as_str())
                && event
                    .get("tagId")
                    .and_then(Value::as_str)
                    .is_some_and(|tag_id| allowed_tags.contains(tag_id))
        })
        .collect()
}

async fn send_json<S>(sender: &mut S, value: Value) -> Result<(), axum::Error>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    sender.send(Message::Text(value.to_string().into())).await
}

async fn close_socket(
    socket: &mut WebSocket,
    code: u16,
    reason: &'static str,
) -> Result<(), axum::Error> {
    socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_never_claim_the_shadow_worker_is_active() {
        let state = ShadowState::new();
        state.set_ready(true);
        state.record_telemetry(3, 1);
        let snapshot = state.snapshot();
        assert!(snapshot.ok);
        assert!(!snapshot.active);
        assert!(
            state
                .metrics()
                .contains("scamatic_shadow_telemetry_events_total 3")
        );
    }

    #[test]
    fn telemetry_filter_enforces_workspace_project_and_tag_scope() {
        let session = IsaacSession {
            runtime_session_id: "runtime".into(),
            user_id: "user".into(),
            workspace_id: "workspace-a".into(),
            project_id: "project-a".into(),
            version_id: "version-a".into(),
            capabilities: vec!["runtime.view".into()],
            allowed_tag_ids: vec!["tag-a".into()],
            expires_at: "2026-08-28T00:00:00.000Z".into(),
        };
        let allowed = HashSet::from(["tag-a".to_string()]);
        let filtered = filter_telemetry(
            &session,
            &allowed,
            vec![
                json!({ "workspaceId": "workspace-a", "projectId": "project-a", "tagId": "tag-a", "value": 1 }),
                json!({ "workspaceId": "workspace-a", "projectId": "project-b", "tagId": "tag-a", "value": 2 }),
                json!({ "workspaceId": "workspace-a", "projectId": "project-a", "tagId": "tag-b", "value": 3 }),
            ],
        );
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["value"], 1);
    }
}
