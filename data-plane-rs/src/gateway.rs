use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::env;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::broadcast;
use tokio::time::timeout;

const MAX_INTERNAL_RESPONSE_BYTES: u64 = 2_097_152;
const DEFAULT_REVALIDATE_MS: u64 = 5_000;

#[derive(Clone)]
pub struct IsaacGatewayConfig {
    pub enabled: bool,
    pub bind: SocketAddr,
    pub allowed_origins: HashSet<String>,
    pub authorizer: Option<InternalAuthorizer>,
    pub revalidate_every: Duration,
}

impl IsaacGatewayConfig {
    pub fn from_environment() -> io::Result<Self> {
        let enabled = env::var("SCADA_ISAAC_GATEWAY_ENABLED").as_deref() == Ok("true");
        let bind = env::var("SCADA_ISAAC_STREAM_BIND")
            .unwrap_or_else(|_| "127.0.0.1:3003".to_string())
            .parse::<SocketAddr>()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid Isaac bind"))?;
        if enabled && (!bind.ip().is_loopback() || bind.port() == 0) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Isaac canary must bind to a fixed loopback port behind the configured edge",
            ));
        }
        let allowed_origins = env::var("SCADA_ISAAC_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 300
                    && (value.starts_with("http://") || value.starts_with("https://"))
            })
            .map(str::to_string)
            .collect::<HashSet<_>>();
        let revalidate_ms = env::var("SCADA_ISAAC_REVALIDATE_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(DEFAULT_REVALIDATE_MS)
            .clamp(1_000, 30_000);
        let authorizer = if enabled {
            if allowed_origins.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Isaac canary requires at least one allowed browser origin",
                ));
            }
            Some(InternalAuthorizer::from_environment()?)
        } else {
            None
        };
        Ok(Self {
            enabled,
            bind,
            allowed_origins,
            authorizer,
            revalidate_every: Duration::from_millis(revalidate_ms),
        })
    }
}

#[derive(Clone)]
pub struct InternalAuthorizer {
    host: String,
    port: u16,
    token: String,
}

impl InternalAuthorizer {
    fn from_environment() -> io::Result<Self> {
        let host =
            env::var("SCADA_ISAAC_INTERNAL_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        if host != "127.0.0.1" && host != "localhost" {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Isaac internal authorizer must use loopback",
            ));
        }
        let port = env::var("SCADA_ISAAC_INTERNAL_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "invalid Isaac internal port")
            })?;
        let token = env::var("SCADA_ISAAC_INTERNAL_TOKEN").unwrap_or_default();
        if token.len() < 32
            || token.len() > 200
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid Isaac internal token",
            ));
        }
        Ok(Self { host, port, token })
    }

    pub async fn authorize(&self, ticket: &str) -> Option<IsaacSession> {
        self.request(json!({ "action": "authorize", "ticket": ticket }))
            .await
    }

    pub async fn revalidate(&self, runtime_session_id: &str) -> Option<IsaacSession> {
        self.request(json!({ "action": "revalidate", "runtimeSessionId": runtime_session_id }))
            .await
    }

    async fn request(&self, body: Value) -> Option<IsaacSession> {
        let body = serde_json::to_vec(&body).ok()?;
        let address = format!("{}:{}", self.host, self.port);
        let mut stream = timeout(Duration::from_secs(2), TcpStream::connect(address))
            .await
            .ok()?
            .ok()?;
        let headers = format!(
            "POST /internal/isaac/runtime-session HTTP/1.1\r\nHost: {}:{}\r\nContent-Type: application/json\r\nX-Isaac-Internal-Token: {}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
            self.host,
            self.port,
            self.token,
            body.len(),
        );
        timeout(Duration::from_secs(2), async {
            stream.write_all(headers.as_bytes()).await?;
            stream.write_all(&body).await?;
            stream.flush().await
        })
        .await
        .ok()?
        .ok()?;
        let mut response = Vec::new();
        timeout(
            Duration::from_secs(3),
            stream
                .take(MAX_INTERNAL_RESPONSE_BYTES)
                .read_to_end(&mut response),
        )
        .await
        .ok()?
        .ok()?;
        let header_end = response.windows(4).position(|part| part == b"\r\n\r\n")?;
        let headers = std::str::from_utf8(&response[..header_end]).ok()?;
        if !headers.lines().next()?.contains(" 200 ") {
            return None;
        }
        let parsed: AuthorizationResponse =
            serde_json::from_slice(&response[header_end + 4..]).ok()?;
        if parsed.ok { parsed.session } else { None }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsaacSession {
    pub runtime_session_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub version_id: String,
    pub capabilities: Vec<String>,
    pub allowed_tag_ids: Vec<String>,
    pub expires_at: String,
}

impl IsaacSession {
    pub fn same_scope(&self, other: &Self) -> bool {
        self.runtime_session_id == other.runtime_session_id
            && self.user_id == other.user_id
            && self.workspace_id == other.workspace_id
            && self.project_id == other.project_id
            && self.version_id == other.version_id
    }

    pub fn can_receive_commands(&self) -> bool {
        self.capabilities
            .iter()
            .any(|capability| capability == "command.execute")
    }
}

#[derive(Deserialize)]
struct AuthorizationResponse {
    ok: bool,
    session: Option<IsaacSession>,
}

#[derive(Clone, Debug)]
pub struct CommandScope {
    pub user_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub version_id: String,
}

impl CommandScope {
    pub fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            user_id: identifier(value, "userId")?,
            workspace_id: identifier(value, "workspaceId")?,
            project_id: identifier(value, "projectId")?,
            version_id: identifier(value, "versionId")?,
        })
    }
}

#[derive(Clone, Debug)]
pub enum IsaacEvent {
    Telemetry(Vec<Value>),
    Command { event: Value, scope: CommandScope },
}

pub struct IsaacGateway {
    pub config: IsaacGatewayConfig,
    events: broadcast::Sender<IsaacEvent>,
    clients: AtomicU64,
    auth_failures: AtomicU64,
    lagged_clients: AtomicU64,
    delivered_events: AtomicU64,
}

impl IsaacGateway {
    pub fn new(config: IsaacGatewayConfig) -> Self {
        let (events, _) = broadcast::channel(1_024);
        Self {
            config,
            events,
            clients: AtomicU64::new(0),
            auth_failures: AtomicU64::new(0),
            lagged_clients: AtomicU64::new(0),
            delivered_events: AtomicU64::new(0),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<IsaacEvent> {
        self.events.subscribe()
    }

    pub fn publish_telemetry(&self, events: Vec<Value>) {
        if !events.is_empty() {
            let _ = self.events.send(IsaacEvent::Telemetry(events));
        }
    }

    pub fn publish_command(&self, event: Value, scope: CommandScope) {
        let _ = self.events.send(IsaacEvent::Command { event, scope });
    }

    pub fn origin_allowed(&self, origin: &str) -> bool {
        self.config.allowed_origins.contains(origin)
    }

    pub fn client_opened(&self) {
        self.clients.fetch_add(1, Ordering::Relaxed);
    }

    pub fn client_closed(&self) {
        self.clients.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn record_auth_failure(&self) {
        self.auth_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_lagged(&self) {
        self.lagged_clients.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_delivered(&self, count: u64) {
        self.delivered_events.fetch_add(count, Ordering::Relaxed);
    }

    pub fn counters(&self) -> GatewayCounters {
        GatewayCounters {
            clients: self.clients.load(Ordering::Relaxed),
            auth_failures: self.auth_failures.load(Ordering::Relaxed),
            lagged_clients: self.lagged_clients.load(Ordering::Relaxed),
            delivered_events: self.delivered_events.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct GatewayCounters {
    pub clients: u64,
    pub auth_failures: u64,
    pub lagged_clients: u64,
    pub delivered_events: u64,
}

fn identifier(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.len() <= 200)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_scope_requires_complete_bounded_identity() {
        let valid =
            json!({ "userId": "u", "workspaceId": "w", "projectId": "p", "versionId": "v" });
        assert!(CommandScope::from_value(&valid).is_some());
        assert!(CommandScope::from_value(&json!({ "userId": "u" })).is_none());
    }

    #[test]
    fn session_scope_and_command_capability_are_explicit() {
        let session = IsaacSession {
            runtime_session_id: "runtime".into(),
            user_id: "user".into(),
            workspace_id: "workspace".into(),
            project_id: "project".into(),
            version_id: "version".into(),
            capabilities: vec!["runtime.view".into(), "command.execute".into()],
            allowed_tag_ids: vec!["tag".into()],
            expires_at: "2026-08-28T00:00:00.000Z".into(),
        };
        assert!(session.same_scope(&session));
        assert!(session.can_receive_commands());
    }
}
