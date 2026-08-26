use crate::state::{ShadowSnapshot, ShadowState};
use axum::extract::State;
use axum::http::{HeaderValue, header::CONTENT_TYPE};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::watch;

pub fn router(state: Arc<ShadowState>) -> Router {
    Router::new()
        .route("/health/live", get(liveness))
        .route("/health/ready", get(readiness))
        .route("/metrics", get(metrics))
        .with_state(state)
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
}
