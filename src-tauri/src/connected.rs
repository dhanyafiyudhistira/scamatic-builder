use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::header::{CONTENT_TYPE, HeaderName, HeaderValue, ORIGIN, SET_COOKIE, USER_AGENT};
use reqwest::{Client, Method, redirect::Policy};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use url::Url;

#[cfg(feature = "local-runtime")]
const DEFAULT_SERVER_ORIGIN: &str = "http://127.0.0.1:3001";
#[cfg(not(feature = "local-runtime"))]
const DEFAULT_SERVER_ORIGIN: &str = "https://scada-dhany-wtp.vercel.app";
const MAX_PATH_BYTES: usize = 2_048;
const MAX_REQUEST_BYTES: usize = 6 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ASSET_BYTES: usize = 4 * 1024 * 1024;
const CSRF_COOKIE: &str = "scada_csrf";
const DESIGN_ASSET_MIME_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/svg+xml"];

#[derive(Clone)]
pub struct DesktopApi {
    client: Client,
    origin: Url,
    origin_header: HeaderValue,
    csrf_token: Arc<RwLock<Option<String>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopApiRequest {
    pub path: String,
    pub method: Option<String>,
    pub body: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopApiResponse {
    pub status: u16,
    pub ok: bool,
    pub body: serde_json::Value,
    pub correlation_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    pub desktop: bool,
    pub server_origin: String,
    pub api_transport: &'static str,
    pub runtime_transport: &'static str,
    pub isaac_protocol_version: u8,
    pub standard_fallback: bool,
}

impl DesktopApi {
    pub fn from_environment() -> Result<Self, String> {
        let configured = std::env::var("SCAMATIC_DESKTOP_SERVER_ORIGIN")
            .ok()
            .or_else(|| option_env!("SCAMATIC_DESKTOP_SERVER_ORIGIN").map(str::to_owned))
            .unwrap_or_else(|| DEFAULT_SERVER_ORIGIN.to_owned());
        Self::for_origin(&configured)
    }

    fn for_origin(configured: &str) -> Result<Self, String> {
        let origin = validate_server_origin(configured)?;
        let origin_text = origin.origin().ascii_serialization();
        let origin_header = HeaderValue::from_str(&origin_text).map_err(|_| {
            "desktop server origin cannot be represented as an HTTP header".to_owned()
        })?;
        let client = Client::builder()
            .cookie_store(true)
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .redirect(Policy::none())
            .user_agent("SCAMATIC-Desktop/0.2")
            .build()
            .map_err(|error| format!("could not initialize the connected client: {error}"))?;
        Ok(Self {
            client,
            origin,
            origin_header,
            csrf_token: Arc::new(RwLock::new(None)),
        })
    }

    pub fn info(&self) -> DesktopInfo {
        DesktopInfo {
            desktop: true,
            server_origin: self.origin.origin().ascii_serialization(),
            api_transport: "rust-http",
            runtime_transport: "rust-websocket",
            isaac_protocol_version: scamatic_data_plane::protocol::PROTOCOL_VERSION,
            standard_fallback: true,
        }
    }

    pub fn server_origin(&self) -> &Url {
        &self.origin
    }

    pub fn origin_header(&self) -> HeaderValue {
        self.origin_header.clone()
    }

    pub async fn request(&self, input: DesktopApiRequest) -> Result<DesktopApiResponse, String> {
        let method = parse_method(input.method.as_deref().unwrap_or("GET"))?;
        let url = self.resolve_path(&input.path)?;
        let body = input.body.unwrap_or_default();
        if body.len() > MAX_REQUEST_BYTES {
            return Err("desktop API request body is too large".to_owned());
        }

        let mut request = self
            .client
            .request(method.clone(), url)
            .header(ORIGIN, self.origin_header.clone())
            .header(USER_AGENT, "SCAMATIC-Desktop/0.2");
        if !body.is_empty() {
            request = request.header(CONTENT_TYPE, "application/json").body(body);
        }
        for (name, value) in permitted_headers(&input.headers)? {
            request = request.header(name, value);
        }
        if !matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) {
            if let Some(token) = self.csrf_token.read().await.as_deref() {
                request = request.header("x-csrf-token", token);
            }
        }

        let mut response = request
            .send()
            .await
            .map_err(|error| format!("connected server request failed: {error}"))?;
        self.capture_csrf(response.headers()).await;
        let status = response.status();
        let correlation_id = response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
        {
            return Err("connected server response is too large".to_owned());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("could not read connected server response: {error}"))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err("connected server response is too large".to_owned());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = if bytes.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| {
                serde_json::json!({
                    "message": String::from_utf8_lossy(&bytes),
                })
            })
        };
        Ok(DesktopApiResponse {
            status: status.as_u16(),
            ok: status.is_success(),
            body,
            correlation_id,
        })
    }

    pub async fn asset_data_url(&self, path: &str) -> Result<String, String> {
        let url = self.resolve_asset_path(path)?;
        let mut response = self
            .client
            .get(url)
            .header(ORIGIN, self.origin_header.clone())
            .header(USER_AGENT, "SCAMATIC-Desktop/0.2")
            .send()
            .await
            .map_err(|error| format!("connected design asset request failed: {error}"))?;
        self.capture_csrf(response.headers()).await;
        if !response.status().is_success() {
            return Err(format!(
                "connected design asset request failed with status {}",
                response.status().as_u16()
            ));
        }
        let mime_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .filter(|value| DESIGN_ASSET_MIME_TYPES.contains(value))
            .map(str::to_owned)
            .ok_or_else(|| "connected design asset has an unsupported media type".to_owned())?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_ASSET_BYTES as u64)
        {
            return Err("connected design asset is too large".to_owned());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("could not read connected design asset: {error}"))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_ASSET_BYTES {
                return Err("connected design asset is too large".to_owned());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err("connected design asset is empty".to_owned());
        }
        Ok(format!(
            "data:{mime_type};base64,{}",
            STANDARD.encode(bytes)
        ))
    }

    fn resolve_path(&self, path: &str) -> Result<Url, String> {
        if path.is_empty()
            || path.len() > MAX_PATH_BYTES
            || !path.starts_with('/')
            || path.starts_with("//")
            || path.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err("desktop API path is invalid".to_owned());
        }
        let url = self
            .origin
            .join(path)
            .map_err(|_| "desktop API path is invalid".to_owned())?;
        if url.origin() != self.origin.origin()
            || !(url.path() == "/health/data-plane/shadow" || url.path().starts_with("/api/"))
        {
            return Err("desktop API path is outside the connected server scope".to_owned());
        }
        Ok(url)
    }

    fn resolve_asset_path(&self, path: &str) -> Result<Url, String> {
        let url = self.resolve_path(path)?;
        if url.path() != "/api/elements" || url.fragment().is_some() {
            return Err(
                "desktop design asset path is outside the connected asset scope".to_owned(),
            );
        }
        let mut project_id = None;
        let mut asset_id = None;
        for (name, value) in url.query_pairs() {
            if !safe_asset_identifier(&value) {
                return Err("desktop design asset identifier is invalid".to_owned());
            }
            match name.as_ref() {
                "projectId" if project_id.is_none() => project_id = Some(value.into_owned()),
                "assetId" if asset_id.is_none() => asset_id = Some(value.into_owned()),
                _ => return Err("desktop design asset query is invalid".to_owned()),
            }
        }
        if project_id.is_none() || asset_id.is_none() {
            return Err("desktop design asset query is incomplete".to_owned());
        }
        Ok(url)
    }

    async fn capture_csrf(&self, headers: &reqwest::header::HeaderMap) {
        for header in headers.get_all(SET_COOKIE) {
            let Ok(raw) = header.to_str() else { continue };
            let Some(value) = response_cookie(raw, CSRF_COOKIE) else {
                continue;
            };
            *self.csrf_token.write().await = (!value.is_empty()).then_some(value);
        }
    }
}

fn safe_asset_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_server_origin(value: &str) -> Result<Url, String> {
    let url =
        Url::parse(value.trim()).map_err(|_| "desktop server origin is not a URL".to_owned())?;
    let loopback = url
        .host_str()
        .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("desktop server must be an HTTPS origin or an HTTP loopback origin".to_owned());
    }
    Ok(url)
}

fn parse_method(value: &str) -> Result<Method, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "HEAD" => Ok(Method::HEAD),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        _ => Err("desktop API method is not allowed".to_owned()),
    }
}

fn permitted_headers(
    input: &HashMap<String, String>,
) -> Result<Vec<(HeaderName, HeaderValue)>, String> {
    input
        .iter()
        .filter(|(name, _)| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "x-runtime-token" | "x-request-id"
            )
        })
        .map(|(name, value)| {
            if value.len() > 4_096 || value.bytes().any(|byte| byte.is_ascii_control()) {
                return Err("desktop API header value is invalid".to_owned());
            }
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "desktop API header name is invalid".to_owned())?;
            let value = HeaderValue::from_str(value)
                .map_err(|_| "desktop API header value is invalid".to_owned())?;
            Ok((name, value))
        })
        .collect()
}

fn response_cookie(header: &str, name: &str) -> Option<String> {
    let pair = header.split(';').next()?;
    let (cookie_name, value) = pair.split_once('=')?;
    (cookie_name.trim() == name).then(|| value.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[test]
    fn connected_server_requires_a_clean_secure_or_loopback_origin() {
        assert!(validate_server_origin("https://scada.example").is_ok());
        assert!(validate_server_origin("http://127.0.0.1:3001").is_ok());
        assert!(validate_server_origin("http://scada.example").is_err());
        assert!(validate_server_origin("https://scada.example/api").is_err());
        assert!(validate_server_origin("https://user@scada.example").is_err());
    }

    #[test]
    fn csrf_cookie_extraction_is_exact() {
        assert_eq!(
            response_cookie("scada_csrf=token_123; Path=/; SameSite=Strict", CSRF_COOKIE),
            Some("token_123".to_owned())
        );
        assert_eq!(response_cookie("other=value; Path=/", CSRF_COOKIE), None);
    }

    #[test]
    fn only_runtime_and_correlation_headers_cross_the_ipc_boundary() {
        let headers = HashMap::from([
            ("X-Runtime-Token".to_owned(), "runtime".to_owned()),
            ("Authorization".to_owned(), "secret".to_owned()),
        ]);
        let permitted = permitted_headers(&headers).unwrap();
        assert_eq!(permitted.len(), 1);
        assert_eq!(permitted[0].0, "x-runtime-token");
    }

    #[tokio::test]
    async fn connected_client_keeps_http_only_session_and_forwards_csrf() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first_stream, first) = read_request(&listener).await;
            assert!(first.starts_with("POST /api/auth HTTP/1.1"));
            respond(
                &mut first_stream,
                &[
                    "Set-Cookie: scada_session=session_123; Path=/; HttpOnly; SameSite=Strict",
                    "Set-Cookie: scada_csrf=csrf_123; Path=/; SameSite=Strict",
                ],
            )
            .await;

            let (mut second_stream, second) = read_request(&listener).await;
            let second = second.to_ascii_lowercase();
            assert!(second.starts_with("patch /api/auth http/1.1"));
            assert!(
                second.contains("cookie: scada_csrf=csrf_123; scada_session=session_123")
                    || second.contains("cookie: scada_session=session_123; scada_csrf=csrf_123")
            );
            assert!(second.contains("x-csrf-token: csrf_123"));
            assert!(second.contains(&format!("origin: http://{address}")));
            respond(&mut second_stream, &[]).await;

            let (mut asset_stream, asset) = read_request(&listener).await;
            let asset = asset.to_ascii_lowercase();
            assert!(
                asset.starts_with(
                    "get /api/elements?projectid=project-123&assetid=asset-456 http/1.1"
                )
            );
            assert!(
                asset.contains("cookie: scada_csrf=csrf_123; scada_session=session_123")
                    || asset.contains("cookie: scada_session=session_123; scada_csrf=csrf_123")
            );
            respond_bytes(&mut asset_stream, "image/png", &[1, 2, 3]).await;
        });

        let client = DesktopApi::for_origin(&format!("http://{address}")).unwrap();
        let login = client
            .request(DesktopApiRequest {
                path: "/api/auth".to_owned(),
                method: Some("POST".to_owned()),
                body: Some(r#"{"email":"operator@example.test","password":"secret"}"#.to_owned()),
                headers: HashMap::new(),
            })
            .await
            .unwrap();
        assert!(login.ok);
        assert_eq!(login.body, serde_json::json!({ "ok": true }));
        let mutation = client
            .request(DesktopApiRequest {
                path: "/api/auth".to_owned(),
                method: Some("PATCH".to_owned()),
                body: Some("{}".to_owned()),
                headers: HashMap::new(),
            })
            .await
            .unwrap();
        assert!(mutation.ok);
        let asset = client
            .asset_data_url("/api/elements?projectId=project-123&assetId=asset-456")
            .await
            .unwrap();
        assert_eq!(asset, "data:image/png;base64,AQID");
        server.await.unwrap();
    }

    #[test]
    fn connected_asset_path_is_exact_and_identifier_scoped() {
        let client = DesktopApi::for_origin("https://scada.example").unwrap();
        assert!(
            client
                .resolve_asset_path("/api/elements?projectId=project-123&assetId=asset-456")
                .is_ok()
        );
        assert!(
            client
                .resolve_asset_path("/api/elements?projectId=project-123&assetId=asset-456&raw=1")
                .is_err()
        );
        assert!(
            client
                .resolve_asset_path("/api/runtime?projectId=project-123&assetId=asset-456")
                .is_err()
        );
        assert!(
            client
                .resolve_asset_path("/api/elements?projectId=project/123&assetId=asset-456")
                .is_err()
        );
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn local_runtime_build_defaults_to_the_packaged_loopback_service() {
        assert_eq!(DEFAULT_SERVER_ORIGIN, "http://127.0.0.1:3001");
    }

    async fn read_request(listener: &TcpListener) -> (TcpStream, String) {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0_u8; 16 * 1024];
        let count = stream.read(&mut bytes).await.unwrap();
        let request = String::from_utf8(bytes[..count].to_vec()).unwrap();
        (stream, request)
    }

    async fn respond(stream: &mut TcpStream, headers: &[&str]) {
        let mut response = String::from(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 11\r\n",
        );
        for header in headers {
            response.push_str(header);
            response.push_str("\r\n");
        }
        response.push_str("\r\n{\"ok\":true}");
        stream.write_all(response.as_bytes()).await.unwrap();
    }

    async fn respond_bytes(stream: &mut TcpStream, content_type: &str, body: &[u8]) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
    }
}
