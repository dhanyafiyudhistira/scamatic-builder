mod http;
mod protocol;
mod state;

use protocol::{ControlFlow, OUTPUT_SOURCE, PROTOCOL_VERSION};
use serde::Serialize;
use serde_json::json;
use state::ShadowState;
use std::error::Error;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::{Mutex, watch};
use tokio::time::{Duration, MissedTickBehavior};

type Output = Arc<Mutex<BufWriter<tokio::io::Stdout>>>;

#[derive(Serialize)]
struct OutputFrame<T: Serialize> {
    source: &'static str,
    version: u8,
    #[serde(rename = "type")]
    kind: &'static str,
    ts: u64,
    payload: T,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let state = Arc::new(ShadowState::new());
    let output = Arc::new(Mutex::new(BufWriter::new(tokio::io::stdout())));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let health_url = format!("http://{address}");
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    state.set_ready(true);
    emit(
        &output,
        "shadow.worker.hello",
        json!({
            "pid": std::process::id(),
            "mode": "shadow",
            "active": false,
            "healthUrl": health_url,
            "capabilities": ["telemetry-observe", "command-status-observe", "health", "metrics"]
        }),
    )
    .await?;
    emit(&output, "shadow.worker.health", state.snapshot()).await?;
    eprintln!("[RustShadow] Axum health and metrics listening on {address}");

    let server_state = Arc::clone(&state);
    let server =
        tokio::spawn(async move { http::serve(listener, server_state, shutdown_rx).await });
    let heartbeat_state = Arc::clone(&state);
    let heartbeat_output = Arc::clone(&output);
    let mut heartbeat_shutdown = shutdown_tx.subscribe();
    let heartbeat = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if emit(&heartbeat_output, "shadow.worker.health", heartbeat_state.snapshot()).await.is_err() {
                        break;
                    }
                }
                changed = heartbeat_shutdown.changed() => {
                    if changed.is_err() || *heartbeat_shutdown.borrow() {
                        break;
                    }
                }
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        match protocol::handle_line(&line, &state) {
            Ok(ControlFlow::Continue) => {}
            Ok(ControlFlow::Shutdown) => break,
            Err(code) => {
                emit(
                    &output,
                    "shadow.worker.protocol-error",
                    json!({ "code": code }),
                )
                .await?;
            }
        }
    }

    state.set_ready(false);
    let _ = shutdown_tx.send(true);
    let _ = heartbeat.await;
    match server.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(error.into()),
        Err(error) => return Err(error.into()),
    }
    emit(&output, "shadow.worker.stopped", state.snapshot()).await?;
    Ok(())
}

async fn emit<T: Serialize>(
    output: &Output,
    kind: &'static str,
    payload: T,
) -> std::io::Result<()> {
    let frame = OutputFrame {
        source: OUTPUT_SOURCE,
        version: PROTOCOL_VERSION,
        kind,
        ts: unix_time_ms(),
        payload,
    };
    let mut line = serde_json::to_vec(&frame).map_err(std::io::Error::other)?;
    line.push(b'\n');
    let mut writer = output.lock().await;
    writer.write_all(&line).await?;
    writer.flush().await
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}
