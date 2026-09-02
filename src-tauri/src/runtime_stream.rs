use crate::connected::DesktopApi;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::Channel;
use tokio::sync::{Mutex, oneshot};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::{ORIGIN, USER_AGENT};
use tokio_tungstenite::tungstenite::protocol::Message;
use url::Url;

const MAX_STREAM_URL_BYTES: usize = 2_048;
const MAX_TICKET_BYTES: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStreamRequest {
    pub url: String,
    pub ticket: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum DesktopStreamEvent {
    Open,
    Message { data: String },
    Error { message: String },
    Close { code: u16, reason: String },
}

#[derive(Clone, Default)]
pub struct DesktopRuntimeStreams {
    next_id: Arc<AtomicU64>,
    cancellations: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl DesktopRuntimeStreams {
    pub async fn connect(
        &self,
        api: &DesktopApi,
        input: DesktopStreamRequest,
        events: Channel<DesktopStreamEvent>,
    ) -> Result<String, String> {
        let url = validate_stream_request(api.server_origin(), &input)?;
        let origin = api
            .origin_header()
            .to_str()
            .map_err(|_| "connected server origin is invalid".to_owned())?
            .to_owned();
        let connection_id = format!(
            "desktop-stream-{}-{}",
            std::process::id(),
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.cancellations
            .lock()
            .await
            .insert(connection_id.clone(), cancel_tx);

        let cancellations = Arc::clone(&self.cancellations);
        let task_id = connection_id.clone();
        tauri::async_runtime::spawn(async move {
            run_stream(url, origin, events, cancel_rx).await;
            cancellations.lock().await.remove(&task_id);
        });
        Ok(connection_id)
    }

    pub async fn disconnect(&self, connection_id: &str) -> bool {
        let cancellation = self.cancellations.lock().await.remove(connection_id);
        cancellation.is_some_and(|sender| sender.send(()).is_ok())
    }
}

fn validate_stream_request(
    server_origin: &Url,
    input: &DesktopStreamRequest,
) -> Result<Url, String> {
    if input.url.is_empty() || input.url.len() > MAX_STREAM_URL_BYTES {
        return Err("runtime stream URL is invalid".to_owned());
    }
    if input.ticket.len() < 20
        || input.ticket.len() > MAX_TICKET_BYTES
        || !input
            .ticket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("runtime stream ticket is invalid".to_owned());
    }
    let mut url = Url::parse(&input.url).map_err(|_| "runtime stream URL is invalid".to_owned())?;
    let expected_scheme = if server_origin.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    if url.scheme() != expected_scheme
        || url.host_str() != server_origin.host_str()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "/runtime-stream" | "/isaac-stream")
    {
        return Err("runtime stream target is outside the connected server scope".to_owned());
    }
    url.query_pairs_mut().append_pair("ticket", &input.ticket);
    Ok(url)
}

async fn run_stream(
    url: Url,
    origin: String,
    events: Channel<DesktopStreamEvent>,
    mut cancel: oneshot::Receiver<()>,
) {
    let request = match websocket_request(&url, &origin) {
        Ok(request) => request,
        Err(error) => {
            send_error_and_close(&events, error);
            return;
        }
    };
    let (mut socket, _) = match connect_async(request).await {
        Ok(connection) => connection,
        Err(error) => {
            send_error_and_close(
                &events,
                format!("runtime stream connection failed: {error}"),
            );
            return;
        }
    };
    let _ = events.send(DesktopStreamEvent::Open);

    loop {
        tokio::select! {
            _ = &mut cancel => {
                let _ = socket.close(None).await;
                let _ = events.send(DesktopStreamEvent::Close { code: 1000, reason: "Desktop stream closed".to_owned() });
                break;
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Text(data))) => {
                        let _ = events.send(DesktopStreamEvent::Message { data: data.to_string() });
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if socket.send(Message::Pong(data)).await.is_err() {
                            send_error_and_close(&events, "runtime stream heartbeat failed".to_owned());
                            break;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame
                            .map(|frame| (frame.code.into(), frame.reason.to_string()))
                            .unwrap_or((1000, "Runtime stream closed".to_owned()));
                        let _ = events.send(DesktopStreamEvent::Close { code, reason });
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        send_error_and_close(&events, format!("runtime stream failed: {error}"));
                        break;
                    }
                    None => {
                        let _ = events.send(DesktopStreamEvent::Close { code: 1006, reason: "Runtime stream ended".to_owned() });
                        break;
                    }
                }
            }
        }
    }
}

fn websocket_request(
    url: &Url,
    origin: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "runtime stream request is invalid".to_owned())?;
    request.headers_mut().insert(
        ORIGIN,
        HeaderValue::from_str(origin).map_err(|_| "runtime stream origin is invalid".to_owned())?,
    );
    request
        .headers_mut()
        .insert(USER_AGENT, HeaderValue::from_static("SCAMATIC-Desktop/0.2"));
    Ok(request)
}

fn send_error_and_close(events: &Channel<DesktopStreamEvent>, message: String) {
    let _ = events.send(DesktopStreamEvent::Error {
        message: message.clone(),
    });
    let _ = events.send(DesktopStreamEvent::Close {
        code: 1011,
        reason: message,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str, ticket: &str) -> DesktopStreamRequest {
        DesktopStreamRequest {
            url: url.to_owned(),
            ticket: ticket.to_owned(),
        }
    }

    #[test]
    fn stream_target_is_same_host_ticketed_and_path_scoped() {
        let server = Url::parse("https://scada.example/").unwrap();
        let ticket = "abcdefghijklmnopqrstuvwxyz_1234";
        let valid = validate_stream_request(
            &server,
            &request("wss://scada.example/isaac-stream", ticket),
        )
        .unwrap();
        assert_eq!(valid.query_pairs().next().unwrap().1, ticket);
        assert!(
            validate_stream_request(
                &server,
                &request("wss://foreign.example/isaac-stream", ticket)
            )
            .is_err()
        );
        assert!(
            validate_stream_request(
                &server,
                &request("ws://scada.example/runtime-stream", ticket)
            )
            .is_err()
        );
        assert!(
            validate_stream_request(&server, &request("wss://scada.example/admin", ticket))
                .is_err()
        );
    }

    #[test]
    fn loopback_desktop_accepts_the_development_stream_ports() {
        let server = Url::parse("http://127.0.0.1:3001/").unwrap();
        let resolved = validate_stream_request(
            &server,
            &request(
                "ws://127.0.0.1:3003/isaac-stream",
                "abcdefghijklmnopqrstuvwxyz_1234",
            ),
        );
        assert!(resolved.is_ok());
    }
}
