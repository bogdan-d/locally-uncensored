use std::sync::Arc;
use std::collections::HashMap;
use std::net::SocketAddr;
use axum::{
    Router,
    body::Body,
    extract::{State as AxumState, Request, ConnectInfo},
    http::{StatusCode, HeaderMap, header, Method},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{any, get, post},
    Json,
};
use tower_http::cors::CorsLayer;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ─── Constants ───

const PASSCODE_TTL_SECS: u64 = 300; // 5 minutes — what the user types on the phone
const JWT_TTL_SECS: u64 = 60 * 60;  // 1 hour — how long an authenticated session lasts
const MAX_FAILED_ATTEMPTS: u32 = 3;
const COOLDOWN_SECS: u64 = 60;

// ─── Shared server state ───

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct RemotePermissions {
    pub filesystem: bool,
    pub downloads: bool,
    pub process_control: bool,
}

impl Default for RemotePermissions {
    fn default() -> Self {
        Self {
            filesystem: false,
            downloads: false,
            process_control: false,
        }
    }
}

#[derive(Clone)]
pub struct PasscodeState {
    pub code: String,
    pub expires_at: u64,
    pub failed_attempts: HashMap<String, (u32, u64)>, // ip -> (count, cooldown_until)
}

#[derive(Clone)]
struct RemoteState {
    jwt_secret: Arc<TokioMutex<String>>,
    passcode: Arc<TokioMutex<PasscodeState>>,
    ollama_port: u16,
    comfy_port: u16,
    permissions: Arc<TokioMutex<RemotePermissions>>,
    connected_devices: Arc<TokioMutex<Vec<ConnectedDevice>>>,
    tunnel_url: Arc<TokioMutex<Option<String>>>,
    dispatched_model: Arc<TokioMutex<String>>,
    dispatched_system_prompt: Arc<TokioMutex<String>>,
    app_handle: AppHandle,
}

#[derive(Clone, Serialize, Debug)]
pub struct ConnectedDevice {
    pub id: String,
    pub ip: String,
    pub user_agent: String,
    pub last_seen: u64,
}

// ─── JWT ───

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    ip: String,
    exp: usize,
}

fn generate_passcode() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!("{:06}", rng.gen_range(0..1000000))
}

fn generate_jwt(secret: &str, ip: &str, sub: &str) -> Result<String, String> {
    use jsonwebtoken::{encode, Header, EncodingKey};
    let exp = chrono_now_secs() + JWT_TTL_SECS;
    let claims = Claims {
        sub: sub.to_string(),
        ip: ip.to_string(),
        exp: exp as usize,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))
        .map_err(|e| e.to_string())
}

fn validate_jwt(secret: &str, token: &str) -> Result<Claims, String> {
    use jsonwebtoken::{decode, Validation, DecodingKey};
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    ).map_err(|e| format!("Invalid token: {}", e))?;
    Ok(data.claims)
}

fn chrono_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Extract the best-guess client IP: prefer reverse-proxy headers (Cloudflare
/// Tunnel sets these), fall back to the direct connection address on LAN.
///
/// Bug #3: on LAN there is no reverse proxy, so both XFF and X-Real-IP are
/// empty and every client collapsed into the "unknown" bucket — sharing one
/// rate-limit window and appearing as the same row in Connected Devices.
fn client_ip(headers: &HeaderMap, socket: Option<SocketAddr>) -> String {
    if let Some(ip) = headers.get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return ip.to_string()
    }
    if let Some(ip) = headers.get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return ip.to_string()
    }
    if let Some(addr) = socket {
        return addr.ip().to_string()
    }
    "unknown".to_string()
}

// ─── Auth middleware ───

async fn auth_middleware(
    AxumState(state): AxumState<RemoteState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();

    // Public routes:
    //   • /mobile                       — the self-contained landing page
    //   • /LU-monogram-white.png         — the single branding asset
    //   • /remote-api/auth               — where the client trades a passcode for a JWT
    //   • /remote-api/status             — minimal liveness ping {status:"ok"}
    //   • /                              — 302 redirect to /mobile
    //
    // Everything else — including /remote-api/status/full, /remote-api/*,
    // /api/*, /comfyui/*, /ws — requires a valid JWT.
    let requires_auth = path.starts_with("/api/")
        || path.starts_with("/comfyui/")
        || path == "/ws"
        || (path.starts_with("/remote-api/")
            && path != "/remote-api/auth"
            && path != "/remote-api/status");
    if !requires_auth {
        return next.run(req).await;
    }

    // Extract JWT from: Authorization header, cookie, or query param
    let auth_header = req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let cookie_header = req.headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let cookie_token = cookie_header.split(';')
        .find_map(|c| {
            let c = c.trim();
            if c.starts_with("lu-remote-token=") {
                Some(&c[16..])
            } else {
                None
            }
        })
        .unwrap_or("");

    let query_token = req.uri().query().unwrap_or("").split('&')
        .find(|p| p.starts_with("token="))
        .map(|p| &p[6..])
        .unwrap_or("");

    let token = if auth_header.starts_with("Bearer ") {
        &auth_header[7..]
    } else if !cookie_token.is_empty() {
        cookie_token
    } else if !query_token.is_empty() {
        query_token
    } else {
        return (StatusCode::UNAUTHORIZED, "Missing authorization").into_response();
    };

    let jwt_secret = state.jwt_secret.lock().await;
    match validate_jwt(&jwt_secret, token) {
        Ok(claims) => {
            drop(jwt_secret);
            // Update last_seen for this device
            let mut devices = state.connected_devices.lock().await;
            if let Some(dev) = devices.iter_mut().find(|d| d.id == claims.sub) {
                dev.last_seen = chrono_now_secs();
            }
            next.run(req).await
        }
        Err(_) => (StatusCode::UNAUTHORIZED, "Invalid or expired token").into_response(),
    }
}

// ─── Route handlers ───

#[derive(Deserialize)]
struct AuthRequest {
    passcode: String,
}

#[derive(Serialize)]
struct AuthResponse {
    token: String,
}

async fn handle_auth(
    AxumState(state): AxumState<RemoteState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<AuthRequest>,
) -> Response {
    let ip = client_ip(&headers, Some(addr));

    let now = chrono_now_secs();

    // Rate limiting + passcode verification
    {
        let mut pc = state.passcode.lock().await;

        // Rate limit check
        if let Some(&(count, cooldown_until)) = pc.failed_attempts.get(&ip) {
            if count >= MAX_FAILED_ATTEMPTS && now < cooldown_until {
                let remaining = cooldown_until - now;
                return (StatusCode::TOO_MANY_REQUESTS,
                    format!("Too many attempts. Try again in {}s", remaining)
                ).into_response();
            }
            // Reset if cooldown expired
            if count >= MAX_FAILED_ATTEMPTS && now >= cooldown_until {
                pc.failed_attempts.remove(&ip);
            }
        }

        // Auto-regenerate expired passcode
        if now >= pc.expires_at {
            pc.code = generate_passcode();
            pc.expires_at = now + PASSCODE_TTL_SECS;
            println!("[Remote] Passcode auto-regenerated (expired)");
        }

        // Verify passcode
        if body.passcode != pc.code {
            let entry = pc.failed_attempts.entry(ip.clone()).or_insert((0, 0));
            entry.0 += 1;
            if entry.0 >= MAX_FAILED_ATTEMPTS {
                entry.1 = now + COOLDOWN_SECS;
            }
            return (StatusCode::FORBIDDEN, "Invalid code").into_response();
        }

        // Success: clear failed attempts
        pc.failed_attempts.remove(&ip);
    }

    let user_agent = headers.get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    // Bug #11: a plain second-precision timestamp collides when two phones
    // authenticate in the same second. Add a random suffix so every device
    // has a stable, unique identifier.
    let device_id = format!("dev-{}-{:x}", chrono_now_secs(), rand::random::<u64>());

    let jwt_secret = state.jwt_secret.lock().await;
    match generate_jwt(&jwt_secret, &ip, &device_id) {
        Ok(token) => {
            drop(jwt_secret);
            // Dedup by IP: if this IP is already registered (reauth, refresh,
            // regenerated passcode), update the existing entry in place
            // instead of stacking a second ghost device. Also auto-prune
            // entries that have been silent for more than the JWT TTL
            // (the client's token would be invalid anyway).
            let now = chrono_now_secs();
            let mut devices = state.connected_devices.lock().await;
            devices.retain(|d| now.saturating_sub(d.last_seen) < JWT_TTL_SECS);
            if let Some(existing) = devices.iter_mut().find(|d| d.ip == ip) {
                existing.id = device_id.clone();
                existing.user_agent = user_agent.clone();
                existing.last_seen = now;
            } else {
                devices.push(ConnectedDevice {
                    id: device_id,
                    ip: ip.clone(),
                    user_agent,
                    last_seen: now,
                });
            }
            drop(devices);

            // Bug #13: cookie lifetime must match the JWT TTL. Otherwise the
            // browser keeps sending a stale cookie for up to 30 days while
            // the JWT inside expired hours ago.
            let cookie = format!(
                "lu-remote-token={}; Path=/; Max-Age={}; SameSite=Strict",
                token, JWT_TTL_SECS
            );
            let mut response = Json(AuthResponse { token }).into_response();
            // Defensive parse: a malformed cookie value would otherwise panic
            // → abort the entire process under `panic = "abort"`.
            if let Ok(cookie_hv) = cookie.parse() {
                response.headers_mut().insert(header::SET_COOKIE, cookie_hv);
            }
            response
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Public endpoint that returns a minimal liveness ping.
/// Bug #4: we previously leaked `version`, `connected_devices`, and
/// `auth_required` unauthenticated, which is a nice fingerprinting handshake
/// for anyone scanning the tunnel URL. Version and device count are now
/// only visible to authenticated clients via `/remote-api/status/full`.
async fn handle_status() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

/// Authenticated status — version + connected-device count for the desktop UI
/// (and any authenticated client that cares). Gated by `auth_middleware`
/// because it lives under `/remote-api/` without being in the public list.
async fn handle_status_full(AxumState(state): AxumState<RemoteState>) -> Json<serde_json::Value> {
    let devices = state.connected_devices.lock().await;
    Json(serde_json::json!({
        "app": "Locally Uncensored",
        "version": env!("CARGO_PKG_VERSION"),
        "connected_devices": devices.len(),
        "auth_required": true,
    }))
}

// ─── Mobile Agent — HTTP bridge to the Tauri agent tool commands ───

#[derive(Deserialize)]
struct AgentToolPayload {
    tool: String,
    #[serde(default)]
    args: serde_json::Value,
}

/// Run a single agent tool on behalf of an authenticated mobile client.
/// Mirrors `executeTool` in `src/api/agents.ts`. Permission-gated so a
/// remote client cannot reach into the desktop without explicit toggle:
///   - file_read / file_write   → requires `filesystem`
///   - code_execute             → requires `filesystem`
///   - image_generate           → requires `process_control`
///   - web_search               → no permission required
async fn handle_agent_tool(
    AxumState(state): AxumState<RemoteState>,
    Json(body): Json<AgentToolPayload>,
) -> Response {
    use tauri::Manager;
    let app_state = match state.app_handle.try_state::<crate::state::AppState>() {
        Some(s) => s,
        None => return (StatusCode::INTERNAL_SERVER_ERROR, "AppState unavailable").into_response(),
    };

    let perms = state.permissions.lock().await.clone();

    let result: Result<serde_json::Value, String> = match body.tool.as_str() {
        "file_read" => {
            if !perms.filesystem {
                return forbidden("filesystem permission disabled for remote clients");
            }
            let path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            crate::commands::agent::file_read(path)
        }
        "file_write" => {
            if !perms.filesystem {
                return forbidden("filesystem permission disabled for remote clients");
            }
            let path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let content = body.args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            crate::commands::agent::file_write(path, content)
        }
        "code_execute" => {
            if !perms.filesystem {
                return forbidden("filesystem permission disabled for remote clients");
            }
            let code = body.args.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let timeout = body.args.get("timeout").and_then(|v| v.as_u64());
            crate::commands::agent::execute_code(code, timeout, app_state)
        }
        "web_search" => {
            let query = body.args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let count = body.args.get("maxResults")
                .or_else(|| body.args.get("count"))
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            crate::commands::search::web_search(query, count, app_state).await
        }
        "web_fetch" => {
            let url = body.args.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if url.is_empty() {
                return (StatusCode::BAD_REQUEST, "web_fetch requires a `url` argument").into_response();
            }
            crate::commands::search::web_fetch(url).await
        }
        "file_list" => {
            if !perms.filesystem {
                return forbidden("filesystem permission disabled for remote clients");
            }
            let path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let recursive = body.args.get("recursive").and_then(|v| v.as_bool());
            let pattern = body.args.get("pattern").and_then(|v| v.as_str()).map(String::from);
            crate::commands::filesystem::fs_list(path, recursive, pattern)
        }
        "file_search" => {
            if !perms.filesystem {
                return forbidden("filesystem permission disabled for remote clients");
            }
            let path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let pattern = body.args.get("query")
                .or_else(|| body.args.get("pattern"))
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            let max = body.args.get("max_results").and_then(|v| v.as_u64()).map(|n| n as u32);
            crate::commands::filesystem::fs_search(path, pattern, max)
        }
        "shell_execute" => {
            if !perms.filesystem {
                return forbidden("filesystem permission disabled for remote clients");
            }
            let command = body.args.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if command.is_empty() {
                return (StatusCode::BAD_REQUEST, "shell_execute requires a `command` argument").into_response();
            }
            let cwd = body.args.get("cwd").and_then(|v| v.as_str()).map(String::from);
            let timeout = body.args.get("timeout").and_then(|v| v.as_u64());
            let shell = body.args.get("shell").and_then(|v| v.as_str()).map(String::from);
            crate::commands::shell::shell_execute(command, None, cwd, timeout, shell).await
        }
        "system_info" => {
            crate::commands::system::system_info()
        }
        "process_list" => {
            crate::commands::system::process_list()
        }
        "screenshot" => {
            if !perms.filesystem {
                return forbidden("filesystem permission disabled (screenshot reads your desktop)");
            }
            crate::commands::system::screenshot()
        }
        "get_current_time" => {
            crate::commands::system::get_current_time()
        }
        "image_generate" => {
            if !perms.process_control {
                return forbidden("ComfyUI access disabled (enable Process Control)");
            }
            // Image generation requires the desktop Agent path — too much
            // plumbing for the remote bridge. Fall back with a clear message.
            Err("image_generate is desktop-only for now. Use the Create tab.".into())
        }
        other => Err(format!("Unknown tool: {}", other)),
    };

    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ─── Mobile chat event (mirror messages to desktop) ───

/// Cap on chat-event content to prevent an authenticated mobile from DoS'ing
/// the desktop with a huge payload. 100 KB comfortably fits any conversation
/// turn; larger than that is almost certainly abuse.
const CHAT_EVENT_MAX_CONTENT: usize = 100 * 1024;

#[derive(Deserialize, Serialize, Clone)]
struct ChatEventPayload {
    role: String,       // "user" | "assistant"
    content: String,
    #[serde(default)]
    model: String,
    /// "lu" | "codex" — mobile tells the desktop which section this message
    /// belongs to. Missing / unknown values default to "lu" on the desktop.
    #[serde(default)]
    mode: String,
    /// Stable per-chat id assigned by mobile. Desktop groups mobile-side
    /// messages from the same mobile chat into a single desktop conversation.
    #[serde(default)]
    chat_id: String,
    /// Optional short title from the mobile side — nicer than "New Chat".
    #[serde(default)]
    chat_title: String,
}

/// Mirror chat messages from the mobile client into the dispatched desktop
/// conversation. Validates the incoming payload (Bug #9):
///   - role must be "user" or "assistant" (never "system" or arbitrary text)
///   - content is capped at CHAT_EVENT_MAX_CONTENT bytes
async fn handle_chat_event(
    AxumState(state): AxumState<RemoteState>,
    Json(body): Json<ChatEventPayload>,
) -> Response {
    if body.role != "user" && body.role != "assistant" {
        return (
            StatusCode::BAD_REQUEST,
            "Invalid role (must be 'user' or 'assistant')",
        ).into_response();
    }
    if body.content.len() > CHAT_EVENT_MAX_CONTENT {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("Content exceeds {} bytes", CHAT_EVENT_MAX_CONTENT),
        ).into_response();
    }
    let _ = state.app_handle.emit("remote-chat-message", &body);
    StatusCode::NO_CONTENT.into_response()
}

// ─── Proxy handlers ───

/// Paths on the Ollama proxy that require the `downloads` permission.
/// These mutate on-disk model state and/or saturate bandwidth.
fn ollama_requires_downloads(path: &str) -> bool {
    path.starts_with("/api/pull")
        || path.starts_with("/api/create")
        || path.starts_with("/api/copy")
        || path.starts_with("/api/delete")
        || path.starts_with("/api/push")
        || path.starts_with("/api/blobs")
}

/// Specific ComfyUI paths that require a higher-than-baseline permission
/// beyond just the master `process_control` toggle. These names the route-
/// level permission on top of the blanket `process_control` gate.
fn comfy_extra_permission(path: &str) -> Option<&'static str> {
    if path.starts_with("/upload") {
        return Some("filesystem")
    }
    if path.starts_with("/customnode") || path.starts_with("/manager") {
        return Some("downloads")
    }
    None
}

fn forbidden(reason: &str) -> Response {
    (StatusCode::FORBIDDEN, reason.to_string()).into_response()
}

/// Proxy requests to Ollama (localhost:11434)
async fn proxy_ollama(
    AxumState(state): AxumState<RemoteState>,
    req: Request,
) -> Response {
    let path = req.uri().path().to_string();

    // Enforce the `downloads` permission for any endpoint that writes model
    // state. Read-only endpoints (/api/tags, /api/chat, /api/show, etc.)
    // always remain open so an authenticated mobile can actually chat.
    if ollama_requires_downloads(&path) {
        let perms = state.permissions.lock().await;
        if !perms.downloads {
            println!("[Remote] BLOCKED (downloads disabled): {} {}", req.method(), path);
            return forbidden("Downloads permission disabled for remote clients");
        }
    }

    let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
    // NOTE: reqwest inside Tauri subprocess fails on "localhost" resolution
    // (known proxy_localhost bug). Use 127.0.0.1 directly.
    let target = format!("http://127.0.0.1:{}{}{}", state.ollama_port, path, query);
    proxy_to_target(&target, req).await
}

/// Proxy requests to ComfyUI (localhost:comfy_port). Remote access to the
/// ComfyUI backend is gated by `process_control` as the master switch, and
/// upload/install routes layer on `filesystem` / `downloads`.
async fn proxy_comfyui(
    AxumState(state): AxumState<RemoteState>,
    req: Request,
) -> Response {
    let stripped = req.uri().path().strip_prefix("/comfyui").unwrap_or(req.uri().path());
    let stripped_owned = stripped.to_string();

    // Baseline: accessing ComfyUI at all requires process_control
    {
        let perms = state.permissions.lock().await;
        if !perms.process_control {
            println!("[Remote] BLOCKED (process_control disabled): {} {}", req.method(), stripped_owned);
            return forbidden("ComfyUI remote access disabled (enable Process Control)");
        }
        if let Some(extra) = comfy_extra_permission(&stripped_owned) {
            let allowed = match extra {
                "filesystem" => perms.filesystem,
                "downloads" => perms.downloads,
                _ => true,
            };
            if !allowed {
                println!("[Remote] BLOCKED ({} disabled): {} {}", extra, req.method(), stripped_owned);
                return forbidden(&format!("{} permission disabled for remote clients", extra));
            }
        }
    }

    let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
    let target = format!("http://127.0.0.1:{}{}{}", state.comfy_port, stripped_owned, query);
    proxy_to_target(&target, req).await
}

async fn proxy_to_target(target: &str, req: Request) -> Response {
    let method = req.method().clone();
    let headers = req.headers().clone();

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Client init: {}", e)).into_response(),
    };

    let mut builder = match method {
        Method::POST => client.post(target),
        Method::PUT => client.put(target),
        Method::DELETE => client.delete(target),
        _ => client.get(target),
    };

    // Forward content-type
    if let Some(ct) = headers.get(header::CONTENT_TYPE) {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }

    // Forward body
    let body_bytes = axum::body::to_bytes(req.into_body(), 100 * 1024 * 1024)
        .await
        .unwrap_or_default();
    if !body_bytes.is_empty() {
        builder = builder.body(body_bytes.to_vec());
    }

    match builder.send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let resp_ct = resp.headers().get(header::CONTENT_TYPE).cloned();
            match resp.bytes().await {
                Ok(bytes) => {
                    let mut response = Response::builder().status(status);
                    if let Some(ct) = resp_ct {
                        response = response.header(header::CONTENT_TYPE, ct);
                    }
                    response.body(Body::from(bytes.to_vec())).unwrap_or_else(|_| {
                        (StatusCode::INTERNAL_SERVER_ERROR, "Response build error").into_response()
                    })
                }
                Err(e) => (StatusCode::BAD_GATEWAY, format!("Read error: {}", e)).into_response(),
            }
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("Proxy error: {}", e)).into_response(),
    }
}

// ─── WebSocket proxy (ComfyUI progress) ───

async fn proxy_comfyui_ws(
    AxumState(state): AxumState<RemoteState>,
    ws: axum::extract::WebSocketUpgrade,
) -> Response {
    // Baseline: the WS progress stream is ComfyUI, gate on process_control
    {
        let perms = state.permissions.lock().await;
        if !perms.process_control {
            return forbidden("ComfyUI remote access disabled (enable Process Control)");
        }
    }
    let comfy_port = state.comfy_port;
    ws.on_upgrade(move |client_socket| async move {
        use futures_util::{SinkExt, StreamExt};

        let ws_url = format!("ws://127.0.0.1:{}/ws", comfy_port);
        let upstream = match tokio_tungstenite::connect_async(&ws_url).await {
            Ok((stream, _)) => stream,
            Err(e) => {
                eprintln!("[Remote WS] Failed to connect to ComfyUI: {}", e);
                return;
            }
        };

        let (mut upstream_write, mut upstream_read) = upstream.split();
        let (mut client_write, mut client_read) = client_socket.split();

        // Forward: client -> ComfyUI
        let client_to_upstream = tokio::spawn(async move {
            while let Some(Ok(msg)) = client_read.next().await {
                let tung_msg = match msg {
                    axum::extract::ws::Message::Text(t) => tokio_tungstenite::tungstenite::Message::Text(t.to_string().into()),
                    axum::extract::ws::Message::Binary(b) => tokio_tungstenite::tungstenite::Message::Binary(b),
                    axum::extract::ws::Message::Ping(p) => tokio_tungstenite::tungstenite::Message::Ping(p),
                    axum::extract::ws::Message::Pong(p) => tokio_tungstenite::tungstenite::Message::Pong(p),
                    axum::extract::ws::Message::Close(_) => return,
                };
                if upstream_write.send(tung_msg).await.is_err() { return; }
            }
        });

        // Forward: ComfyUI -> client
        let upstream_to_client = tokio::spawn(async move {
            while let Some(Ok(msg)) = upstream_read.next().await {
                let axum_msg = match msg {
                    tokio_tungstenite::tungstenite::Message::Text(t) => axum::extract::ws::Message::Text(t.to_string().into()),
                    tokio_tungstenite::tungstenite::Message::Binary(b) => axum::extract::ws::Message::Binary(b),
                    tokio_tungstenite::tungstenite::Message::Ping(p) => axum::extract::ws::Message::Ping(p),
                    tokio_tungstenite::tungstenite::Message::Pong(p) => axum::extract::ws::Message::Pong(p),
                    tokio_tungstenite::tungstenite::Message::Close(_) => return,
                    _ => continue,
                };
                if client_write.send(axum_msg).await.is_err() { return; }
            }
        });

        // Wait for either direction to finish
        tokio::select! {
            _ = client_to_upstream => {},
            _ = upstream_to_client => {},
        }
    })
}

// ─── Mobile landing page ───

async fn mobile_landing() -> Html<String> {
    Html(r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, maximum-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name='theme-color' content='#0e0e0e'>
<title>Locally Uncensored</title>
<!-- Bug #5: no third-party requests. System fonts only, inline SVG icons. -->
<!-- Bug #6: restrictive CSP. Self origin only. Inline styles/scripts are
     required because the whole page is a single Rust string; data: images
     cover base64 thumbnails; we also need base64 for the QR code JS. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --surface:#0e0e0e;--container-low:#131313;--container:#191919;--container-high:#1f1f1f;--container-highest:#262626;
  --primary:#ffffff;--on-primary:#000000;--text-primary:rgba(255,255,255,0.92);--text-secondary:rgba(255,255,255,0.55);
  --text-tertiary:rgba(255,255,255,0.30);--text-quaternary:rgba(255,255,255,0.16);--accent:#a78bfa;--error:#ff4444;
  --radius:2px;--radius-md:6px;--radius-lg:10px;
  --safe-top:env(safe-area-inset-top,0px);--safe-bottom:env(safe-area-inset-bottom,0px);
}
html,body{height:100%;overflow:hidden}
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--surface);color:var(--text-primary);display:flex;flex-direction:column}
#app{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;position:relative}
/* Bug #5: inline SVG icons in place of Material Symbols font. The span
   keeps the legacy class name so existing per-component sizing rules still
   target the icon. The SVG inside scales to `font-size` via width:1em. */
.material-symbols-outlined{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;user-select:none;line-height:0}
.material-symbols-outlined svg{width:1em;height:1em;display:block}
button{-webkit-appearance:none;appearance:none}

/* ── Auth ── */
.auth-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:24px;padding-top:calc(24px + var(--safe-top))}
.auth-mark{width:64px;height:64px;margin-bottom:18px;opacity:0.95;filter:drop-shadow(0 0 28px rgba(255,255,255,0.12))}
.auth-logo{font-size:1.35rem;font-weight:700;letter-spacing:0.05em;color:var(--primary);margin-bottom:6px}
.auth-sub{font-size:0.58rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:44px}
.auth-form{width:100%;max-width:320px;display:flex;flex-direction:column;gap:16px}
.auth-label{font-size:0.58rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:4px}
.auth-input{width:100%;padding:16px;background:var(--container);border:none;border-radius:var(--radius);color:var(--primary);font-size:1.8rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:center;letter-spacing:12px;outline:none;caret-color:var(--primary)}
.auth-input::placeholder{color:var(--text-tertiary);letter-spacing:12px;font-size:1.4rem}
.auth-input:focus{background:var(--container-high)}
.auth-btn{padding:14px;background:var(--primary);color:var(--on-primary);border:none;border-radius:var(--radius);font-family:inherit;font-size:0.72rem;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;transition:opacity 0.15s}
.auth-btn:active{opacity:0.85}
.auth-err{color:var(--error);font-size:0.68rem;text-align:center;min-height:1.2em;letter-spacing:0.02em}

/* ── Shell ── */
.app-shell{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;position:relative}
.app-header{position:sticky;top:0;z-index:90;display:flex;align-items:center;gap:2px;padding:0 10px;height:52px;padding-top:var(--safe-top);min-height:calc(52px + var(--safe-top));background:rgba(14,14,14,0.78);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.04)}
.icon-btn{background:none;border:none;color:var(--text-primary);width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);cursor:pointer;transition:background 0.15s;flex-shrink:0}
.icon-btn:active{background:var(--container)}
.icon-btn.active{color:var(--accent);background:var(--container-high)}
.icon-btn.disabled{opacity:0.25;pointer-events:none}
.icon-btn .material-symbols-outlined{font-size:20px}
.header-brand{display:flex;align-items:center;flex-shrink:0;margin:0 6px 0 2px;padding:4px}
.header-mark{width:22px;height:22px;opacity:0.95;flex-shrink:0;filter:drop-shadow(0 0 6px rgba(255,255,255,0.14))}
.header-mode-tag{font-size:0.52rem;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--accent);padding:3px 7px;background:rgba(167,139,250,0.12);border-radius:var(--radius);margin-left:-2px;flex-shrink:0}
.model-badge{display:flex;align-items:center;gap:4px;margin-left:auto;padding:6px 10px;background:var(--container);border-radius:var(--radius-md);color:var(--text-secondary);font-size:0.66rem;font-weight:500;max-width:170px;border:none;font-family:inherit;cursor:pointer;transition:background 0.15s;flex-shrink:1;min-width:0}
.model-badge:active{background:var(--container-high)}
.model-badge .model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.model-badge .chev{font-size:13px;opacity:0.6;flex-shrink:0}

/* ── Drawer ── */
.drawer-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);z-index:110;opacity:0;pointer-events:none;transition:opacity 0.2s}
.drawer-backdrop.open{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;left:0;bottom:0;width:86vw;max-width:320px;background:var(--container-low);z-index:120;display:flex;flex-direction:column;transform:translateX(-102%);transition:transform 0.24s cubic-bezier(0.16,1,0.3,1);box-shadow:0 8px 40px rgba(0,0,0,0.5);padding-top:var(--safe-top);padding-bottom:var(--safe-bottom)}
.drawer.open{transform:translateX(0)}
.drawer-header{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;flex-shrink:0}
.drawer-brand{display:flex;align-items:center;gap:8px}
.drawer-mark{width:18px;height:18px;opacity:0.95}
.drawer-logo{font-size:0.82rem;font-weight:700;letter-spacing:0.05em;color:var(--primary)}
.drawer-close{background:none;border:none;color:var(--text-secondary);width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);cursor:pointer;margin-right:-4px}
.drawer-close:active{background:var(--container)}
.drawer-close .material-symbols-outlined{font-size:20px}
.drawer-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 0 8px}
.drawer-footer{padding:12px 14px;flex-shrink:0}

/* ── New Chat row ── */
.new-row{display:flex;gap:6px;padding:4px 12px 10px}
.new-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:11px 10px;background:var(--container);color:var(--text-primary);border:1px solid var(--text-quaternary);border-radius:var(--radius-md);cursor:pointer;font-family:inherit;font-size:0.66rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;transition:all 0.15s}
.new-btn:active{background:var(--container-high)}
.new-btn.primary{background:var(--primary);color:var(--on-primary);border-color:var(--primary)}
.new-btn.primary:active{opacity:0.85;background:var(--primary)}
.new-btn .material-symbols-outlined{font-size:16px}

/* ── Section ── */
.section-label{padding:14px 16px 6px;font-size:0.54rem;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-tertiary);font-weight:600;display:flex;align-items:center;justify-content:space-between;cursor:default;user-select:none}
.section-label.toggle{cursor:pointer}
.section-label.toggle:active{color:var(--text-secondary)}
.section-label .material-symbols-outlined{font-size:15px;transition:transform 0.2s;color:var(--text-tertiary)}
.section-label.collapsed .material-symbols-outlined{transform:rotate(-90deg)}

/* ── Chat list ── */
.chat-item{position:relative;display:flex;align-items:center;gap:10px;padding:10px 14px;margin:1px 8px;border-radius:var(--radius-md);cursor:pointer;background:transparent;border:none;width:calc(100% - 16px);color:var(--text-primary);font-family:inherit;font-size:0.74rem;text-align:left;transition:background 0.15s}
.chat-item:active{background:var(--container)}
.chat-item.active{background:var(--container-high)}
.chat-item .material-symbols-outlined{font-size:15px;color:var(--text-tertiary);flex-shrink:0}
.chat-item.active .material-symbols-outlined{color:var(--primary)}
.chat-item-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.chat-item-mode{font-size:0.5rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--accent);flex-shrink:0;padding:2px 5px;background:rgba(167,139,250,0.12);border-radius:var(--radius)}
.chat-item-del{background:none;border:none;color:var(--text-tertiary);width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius);cursor:pointer;flex-shrink:0;opacity:0.7}
.chat-item-del:active{color:var(--error);background:rgba(255,68,68,0.1);opacity:1}
.chat-item-del .material-symbols-outlined{font-size:15px;color:inherit}
.chat-empty{padding:14px 16px;text-align:center;color:var(--text-tertiary);font-size:0.68rem}

/* ── Caveman / Persona ── */
.plugins-block{margin:2px 8px 4px;padding:0;border-radius:var(--radius-md);background:rgba(255,255,255,0.015)}
.sub-toggle{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;user-select:none;font-size:0.7rem;color:var(--text-primary);font-weight:500;border-radius:var(--radius-md);transition:background 0.15s}
.sub-toggle:active{background:var(--container)}
.sub-toggle .sub-name{flex:1}
.sub-toggle .sub-value{font-size:0.58rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);font-weight:600;padding:2px 6px;background:rgba(167,139,250,0.1);border-radius:var(--radius)}
.sub-toggle .material-symbols-outlined{font-size:16px;color:var(--text-tertiary);transition:transform 0.2s}
.sub-toggle.collapsed .material-symbols-outlined{transform:rotate(-90deg)}
.caveman-row{display:flex;gap:4px;padding:2px 12px 8px}
.caveman-chip{flex:1;padding:7px 4px;background:var(--container);border:none;color:var(--text-secondary);border-radius:var(--radius-md);cursor:pointer;font-family:inherit;font-size:0.58rem;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;transition:all 0.15s}
.caveman-chip:active{background:var(--container-high)}
.caveman-chip.active{background:var(--primary);color:var(--on-primary)}
.persona-scroll{max-height:220px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:2px 8px 8px}
.plugins-section-label{padding:14px 16px 6px;font-size:0.58rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-tertiary);font-weight:600}
.plugins-section-label:first-child{padding-top:10px}
.plugins-persona-list{padding:4px 0 8px;max-height:40vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border-top:1px solid rgba(255,255,255,0.04)}
.plug-folder{border-bottom:1px solid rgba(255,255,255,0.04)}
.plug-folder:last-child{border-bottom:none}
.plug-row{display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;user-select:none;font-size:0.78rem;color:var(--text-primary);font-weight:500;transition:background 0.12s}
.plug-row:active{background:var(--container-high)}
.plug-row .plug-name{flex:1}
.plug-row .plug-value{font-size:0.58rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);font-weight:600;padding:3px 7px;background:rgba(167,139,250,0.12);border-radius:var(--radius)}
.plug-row .plug-chev{font-size:18px;color:var(--text-tertiary);transition:transform 0.2s}
.plug-row.open .plug-chev{transform:rotate(180deg)}
.plug-switch{position:relative;display:inline-block;width:30px;height:18px;flex-shrink:0}
.plug-switch input{opacity:0;width:0;height:0;position:absolute}
.plug-switch-track{position:absolute;inset:0;background:var(--container-high);border-radius:10px;transition:background 0.2s;cursor:pointer}
.plug-switch-track::before{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;background:var(--text-tertiary);border-radius:50%;transition:all 0.2s}
.plug-switch input:checked + .plug-switch-track{background:var(--accent)}
.plug-switch input:checked + .plug-switch-track::before{left:14px;background:var(--primary)}
.plug-folder .caveman-row{padding:2px 16px 14px}
.persona-item{display:flex;align-items:center;gap:10px;width:100%;margin:1px 0;padding:8px 12px;background:transparent;border:none;color:var(--text-primary);font-family:inherit;font-size:0.72rem;text-align:left;border-radius:var(--radius-md);cursor:pointer;transition:background 0.15s}
.persona-item:active{background:var(--container)}
.persona-item.active{background:var(--container-high);color:var(--primary);font-weight:600}
.persona-item .material-symbols-outlined{font-size:15px;color:var(--text-tertiary);flex-shrink:0}
.persona-item.active .material-symbols-outlined{color:var(--primary)}
.persona-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.disconnect-btn{width:100%;padding:10px;background:transparent;border:1px solid rgba(255,68,68,0.3);color:var(--error);border-radius:var(--radius-md);cursor:pointer;font-family:inherit;font-size:0.6rem;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;transition:background 0.15s;display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px}
.disconnect-btn:active{background:rgba(255,68,68,0.1)}
.disconnect-btn .material-symbols-outlined{font-size:15px}
.settings-btn{width:100%;padding:10px;background:var(--container);border:1px solid var(--text-quaternary);color:var(--text-primary);border-radius:var(--radius-md);cursor:pointer;font-family:inherit;font-size:0.62rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;transition:background 0.15s;display:flex;align-items:center;justify-content:center;gap:6px}
.settings-btn:active{background:var(--container-high)}
.settings-btn .material-symbols-outlined{font-size:15px}

/* ── Settings sheet ── */
.settings-section-label{padding:14px 16px 4px;font-size:0.55rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-tertiary);font-weight:600}
.settings-row{padding:10px 16px;display:flex;flex-direction:column;gap:6px}
.settings-row-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.settings-row-title{font-size:0.76rem;color:var(--text-primary);font-weight:500}
.settings-row-value{font-size:0.62rem;color:var(--accent);font-family:ui-monospace,Menlo,monospace;font-weight:600;padding:2px 6px;background:rgba(167,139,250,0.12);border-radius:var(--radius)}
.settings-row-desc{font-size:0.56rem;color:var(--text-tertiary);line-height:1.4}
.settings-row input[type=range]{-webkit-appearance:none;width:100%;height:4px;background:var(--container-high);border-radius:4px;outline:none;margin:4px 0 0}
.settings-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--accent);cursor:pointer;border:none}
.settings-row input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--accent);cursor:pointer;border:none}
.settings-row input[type=number]{width:100%;padding:8px 10px;background:var(--container);border:1px solid var(--text-quaternary);border-radius:var(--radius);color:var(--primary);font-family:ui-monospace,Menlo,monospace;font-size:0.76rem;outline:none}
.settings-row input[type=number]:focus{background:var(--container-high)}
.settings-switch-row{padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.settings-danger-row{padding:12px 16px;border-top:1px solid rgba(255,255,255,0.04);margin-top:8px}
.settings-danger-btn{width:100%;padding:10px;background:transparent;border:1px solid rgba(255,68,68,0.3);color:var(--error);border-radius:var(--radius-md);cursor:pointer;font-family:inherit;font-size:0.62rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:6px}
.settings-danger-btn:active{background:rgba(255,68,68,0.1)}
.settings-danger-btn .material-symbols-outlined{font-size:14px}
.perm-note{padding:0 16px 10px;font-size:0.58rem;color:var(--text-tertiary);line-height:1.5}
.perm-note em{color:var(--text-secondary);font-style:normal;font-weight:600}
.perm-loading{padding:30px 16px;text-align:center;font-size:0.72rem;color:var(--text-tertiary)}
.perm-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid rgba(255,255,255,0.04);cursor:pointer}
.perm-row:active{background:var(--container)}
.perm-text{flex:1;min-width:0}
.perm-label{font-size:0.74rem;color:var(--text-primary);font-weight:600}
.perm-desc{font-size:0.58rem;color:var(--text-tertiary);margin-top:2px;line-height:1.5}

/* ── Picker ── */
.picker-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.6);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);display:flex;flex-direction:column;justify-content:flex-end;animation:fadeIn 0.15s ease-out}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.picker-sheet{background:var(--container);border-radius:var(--radius-lg) var(--radius-lg) 0 0;padding:0;max-height:70vh;display:flex;flex-direction:column;animation:slideUp 0.22s cubic-bezier(0.16,1,0.3,1);padding-bottom:var(--safe-bottom)}
@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
.picker-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.06)}
.picker-title{font-size:0.68rem;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-secondary)}
.picker-close{background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px;display:flex}
.picker-close .material-symbols-outlined{font-size:22px}
.picker-list{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 0;flex:1}
.picker-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;cursor:pointer;color:var(--text-primary);font-size:0.76rem;border:none;background:none;width:100%;text-align:left;font-family:inherit;transition:background 0.1s}
.picker-item:active{background:var(--container-high)}
.picker-item.active{color:var(--primary);font-weight:600}
.picker-item .material-symbols-outlined{font-size:18px;color:var(--primary)}
.picker-empty{padding:24px 16px;text-align:center;color:var(--text-tertiary);font-size:0.72rem}

/* ── Chat ── */
.chat-area{flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0}
.chat-welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:14px;user-select:none;padding:20px}
.chat-welcome-mark{width:82px;height:82px;filter:drop-shadow(0 0 38px rgba(255,255,255,0.18));opacity:1}
.chat-welcome-logo{font-size:1.25rem;font-weight:700;letter-spacing:0.06em;color:var(--primary);margin-top:-2px;opacity:0.95}
.chat-welcome-tag{font-size:0.58rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--text-secondary);opacity:0.75}
.chat-messages{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 14px 8px;display:flex;flex-direction:column;gap:2px}
.msg-group{display:flex;flex-direction:column;margin-bottom:12px}
.msg-group.user{align-items:flex-end}
.msg-group.bot{align-items:flex-start}
.msg-imgs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;max-width:85%;justify-content:flex-end}
.msg-imgs img{width:140px;height:140px;object-fit:cover;border-radius:var(--radius-md);display:block;background:var(--container-high)}
.msg-bubble{max-width:85%;font-size:0.84rem;line-height:1.6;padding:10px 14px;word-wrap:break-word;white-space:pre-wrap;overflow-wrap:anywhere}
.msg-bubble.user{background:var(--primary);color:var(--on-primary);border-radius:var(--radius-md) var(--radius-md) var(--radius) var(--radius-md)}
.msg-bubble.bot{background:var(--container-low);color:var(--text-primary);border-radius:var(--radius-md) var(--radius-md) var(--radius-md) var(--radius)}
.msg-model{font-size:0.54rem;letter-spacing:0.08em;color:var(--text-tertiary);margin-top:4px;padding:0 4px}
/* ── Thinking block (parity with desktop ThinkingBlock.tsx) ── */
.think-block{max-width:85%;margin-bottom:4px;border:1px solid rgba(96,165,250,0.18);border-radius:var(--radius-md);background:rgba(96,165,250,0.04);overflow:hidden}
.think-toggle{width:100%;display:flex;align-items:center;gap:6px;padding:6px 10px;background:none;border:none;color:rgba(147,197,253,0.85);font-family:inherit;font-size:0.65rem;letter-spacing:0.06em;text-transform:uppercase;cursor:pointer;transition:background 0.15s}
.think-toggle:active{background:rgba(96,165,250,0.08)}
.think-toggle .think-icon{font-size:14px;color:rgba(96,165,250,0.85)}
.think-toggle .think-label{flex:1;text-align:left;font-weight:600}
.think-toggle .think-chev{font-size:16px;transition:transform 0.2s;color:rgba(147,197,253,0.7)}
.think-block.open .think-toggle .think-chev{transform:rotate(180deg)}
.think-body{display:none;padding:8px 12px 10px;font-size:0.76rem;line-height:1.55;color:rgba(219,234,254,0.82);white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;border-top:1px solid rgba(96,165,250,0.12)}
.think-block.open .think-body{display:block}
.think-body code{background:rgba(0,0,0,0.35);padding:1px 4px;border-radius:var(--radius);font-size:0.72rem;font-family:ui-monospace,Menlo,monospace}
.think-body pre{background:rgba(0,0,0,0.35);padding:8px 10px;border-radius:var(--radius-md);overflow-x:auto;margin:6px 0;font-size:0.72rem}

/* ── Agent steps (transient ReAct scaffolding, collapsed by default) ── */
.agent-steps{max-width:85%;margin-bottom:6px;display:flex;flex-direction:column;gap:4px}
.agent-step{background:rgba(167,139,250,0.05);border:1px solid rgba(167,139,250,0.15);border-radius:var(--radius-md);color:rgba(221,214,254,0.85);overflow:hidden}
.agent-step.agent-observation{background:rgba(52,211,153,0.04);border-color:rgba(52,211,153,0.15);color:rgba(209,250,229,0.85)}
.agent-step.agent-error{background:rgba(239,68,68,0.05);border-color:rgba(239,68,68,0.2);color:rgba(254,202,202,0.85)}
.agent-step-toggle{width:100%;display:flex;align-items:center;gap:8px;padding:7px 10px;background:none;border:none;color:inherit;font-family:inherit;font-size:0.66rem;cursor:pointer;text-align:left}
.agent-step-toggle:active{background:rgba(255,255,255,0.03)}
.agent-step-icon{font-size:14px;flex-shrink:0;color:inherit}
.agent-step-label{flex:1;font-size:0.56rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-tertiary);font-weight:700;min-width:0}
.agent-step-summary{font-size:0.66rem;color:rgba(255,255,255,0.55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:2;min-width:0}
.agent-step-chev{font-size:15px;transition:transform 0.2s;color:var(--text-tertiary);flex-shrink:0}
.agent-step.open .agent-step-chev{transform:rotate(180deg)}
.agent-step-content{display:none;padding:4px 12px 10px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;font-size:0.7rem;border-top:1px solid rgba(255,255,255,0.04)}
.agent-step.open .agent-step-content{display:block}
.agent-step-content code{background:rgba(0,0,0,0.35);padding:1px 4px;border-radius:var(--radius);font-size:0.66rem;font-family:ui-monospace,Menlo,monospace}

/* ── User message actions ── */
.msg-actions-user{align-self:flex-end}

/* ── User-message inline edit ── */
.msg-bubble.user.editing{background:var(--container);padding:0;width:min(85%,480px)}
.msg-edit-area{width:100%;padding:10px 12px;background:transparent;border:none;color:var(--primary);font-family:inherit;font-size:0.84rem;resize:none;outline:none;min-height:44px;line-height:1.5}
.msg-edit-row{display:flex;gap:4px;padding:6px 8px;border-top:1px solid rgba(255,255,255,0.06);justify-content:flex-end}
.msg-edit-btn{padding:5px 10px;background:none;border:1px solid var(--text-quaternary);color:var(--text-secondary);border-radius:var(--radius);font-family:inherit;font-size:0.58rem;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;cursor:pointer}
.msg-edit-btn:active{background:var(--container-highest)}
.msg-edit-btn.primary{background:var(--primary);color:var(--on-primary);border-color:var(--primary)}
.msg-edit-btn.primary:active{opacity:0.85}

.msg-bubble.bot code{background:rgba(0,0,0,0.4);padding:1px 5px;border-radius:var(--radius);font-size:0.78rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid rgba(255,255,255,0.08)}
.msg-bubble.bot pre{background:rgba(0,0,0,0.4);padding:10px 12px;border-radius:var(--radius-md);overflow-x:auto;margin:8px 0;border:1px solid rgba(255,255,255,0.08);position:relative}
.msg-bubble.bot pre code{background:none;padding:0;border:none;font-size:0.76rem}
.msg-actions{display:flex;gap:2px;margin-top:4px;padding:0 4px}
.msg-action-btn{background:none;border:none;color:var(--text-tertiary);cursor:pointer;padding:4px;border-radius:var(--radius);display:flex;align-items:center;transition:color 0.15s}
.msg-action-btn:active{color:var(--text-primary)}
.msg-action-btn .material-symbols-outlined{font-size:15px}
.copy-btn{position:absolute;top:6px;right:6px;background:var(--container-highest);border:none;color:var(--text-tertiary);cursor:pointer;padding:4px;border-radius:var(--radius);display:flex;align-items:center;opacity:0.6}
.copy-btn:active{opacity:1}
.copy-btn .material-symbols-outlined{font-size:14px}
.msg-typing::after{content:'';display:inline-block;width:2px;height:14px;background:var(--primary);margin-left:2px;animation:cursor-blink 0.7s infinite}
@keyframes cursor-blink{0%,100%{opacity:1}50%{opacity:0}}

/* ── Input bar (enlarged per request) ── */
.input-bar{flex-shrink:0;padding:10px 12px 14px;padding-bottom:max(14px,var(--safe-bottom));background:var(--surface);border-top:1px solid rgba(255,255,255,0.04)}
.img-preview-row{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 8px}
.img-preview{position:relative;width:52px;height:52px;border-radius:var(--radius-md);overflow:hidden;background:var(--container-high);flex-shrink:0}
.img-preview img{width:100%;height:100%;object-fit:cover;display:block}
.img-preview-del{position:absolute;top:2px;right:2px;width:18px;height:18px;background:rgba(0,0,0,0.72);border:none;color:var(--primary);display:flex;align-items:center;justify-content:center;border-radius:50%;cursor:pointer;padding:0}
.img-preview-del:active{background:rgba(0,0,0,0.9)}
.img-preview-del .material-symbols-outlined{font-size:12px}
.input-row{display:flex;gap:8px;align-items:flex-end}
.input-row textarea{flex:1;background:var(--container);border:none;border-radius:var(--radius-md);color:var(--text-primary);padding:11px 14px;font-size:0.86rem;font-family:inherit;resize:none;outline:none;max-height:220px;min-height:44px;height:44px;line-height:1.4}
.input-row textarea:focus{background:var(--container-high)}
.input-row textarea::placeholder{color:var(--text-tertiary)}
.attach-btn,.send-btn{width:44px;height:44px;display:flex;align-items:center;justify-content:center;border:none;border-radius:var(--radius-md);cursor:pointer;flex-shrink:0;transition:all 0.15s;padding:0}
.attach-btn{background:var(--container);color:var(--text-secondary)}
.attach-btn:active{background:var(--container-high)}
.attach-btn.disabled{opacity:0.3;pointer-events:none}
.attach-btn .material-symbols-outlined{font-size:20px}
.send-btn{background:var(--primary);color:var(--on-primary)}
.send-btn:disabled{opacity:0.3}
.send-btn:active{opacity:0.85}
.send-btn .material-symbols-outlined{font-size:20px}
</style>
</head>
<body>
<div id="app"></div>
<script>
(function(){
  var TOKEN = localStorage.getItem('lu-remote-token');
  var currentModel = '';
  var dispatchedSystemPrompt = '';
  var availableModels = [];

  // ── Inline SVG icons (Lucide-style). Replaces the Material Symbols
  //    font download to keep the mobile page free of third-party requests.
  var ICON_SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICON_SVG_CLOSE = '</svg>';
  var ICONS = {
    menu:'<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    close:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    add:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    check:'<polyline points="20 6 9 17 4 12"/>',
    expand_more:'<polyline points="6 9 12 15 18 9"/>',
    arrow_upward:'<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    attach_file:'<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41a2 2 0 01-2.83-2.83L15.07 6.1"/>',
    content_copy:'<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
    terminal:'<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    chat_bubble:'<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
    logout:'<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    extension:'<path d="M20 12V8h-4a2 2 0 10-4 0H8v4a2 2 0 110 4v4h4a2 2 0 104 0h4v-4a2 2 0 110-4z"/>',
    auto_awesome:'<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M19 13l.9 2.1L22 16l-2.1.9L19 19l-.9-2.1L16 16l2.1-.9z"/>',
    psychology:'<path d="M9 21c0-2 1-3 1-5 0-1-1-2-2-2a4 4 0 01-4-4V8a5 5 0 0110 0v1c1 0 2 1 2 2 0 1-1 2-1 3 1 0 2 1 2 2v2h-2v3"/>',
    psychology_alt:'<path d="M9 21c0-2 1-3 1-5 0-1-1-2-2-2a4 4 0 01-4-4V8a5 5 0 0110 0v1c1 0 2 1 2 2 0 1-1 2-1 3 1 0 2 1 2 2v2h-2v3"/><circle cx="12" cy="9" r="0.8" fill="currentColor"/>',
    smart_toy:'<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><circle cx="8.5" cy="16" r="1" fill="currentColor"/><circle cx="15.5" cy="16" r="1" fill="currentColor"/>',
    stop:'<rect x="6" y="6" width="12" height="12" rx="1"/>',
    pencil:'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    refresh:'<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/><path d="M20.49 15A9 9 0 015.64 18.36L1 14"/>',
    tune:'<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    trash:'<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>',
    delete_sweep:'<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/>'
  };
  function svgIcon(name){return ICONS[name] ? ICON_SVG_OPEN + ICONS[name] + ICON_SVG_CLOSE : '';}
  // Expose for inline handlers (rare path, but keeps symmetry with prev API)
  window._svgIcon = svgIcon;

  // ── Caveman prompts (parity with desktop) ──
  var CAVEMAN_PROMPTS = {
    lite: 'Be concise and direct. Drop filler words (just, really, basically, actually, simply), hedging, and pleasantries. Retain full grammar and articles. Keep code blocks, file paths, URLs, and commands unchanged. Every response follows this style.',
    full: 'Respond terse like smart caveman. All technical substance stay. Only fluff die. Drop: articles, filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms preferred. Code unchanged. Pattern: [thing] [action] [reason]. [next step]. ACTIVE EVERY RESPONSE.',
    ultra: 'Maximum brevity. Fewest possible words. Telegraphic. Abbreviate (DB/auth/config/fn/impl/req/res). Strip conjunctions. Arrows for flow (X -> Y). No articles, no filler, no pleasantries. Fragments only. Under 3 sentences unless code. Code/paths/URLs unchanged. ACTIVE EVERY RESPONSE.'
  };
  var CAVEMAN_REMINDERS = {
    lite: '[Be concise. No filler.]',
    full: '[Terse. Fragments OK. No fluff.]',
    ultra: '[Max brevity. Telegraphic.]'
  };

  // Cached copy of the desktop's RemotePermissions (filesystem / downloads /
  // process_control). Loaded from /remote-api/permissions on demand and
  // updated via POST when the user toggles. Sampling knobs (temperature etc.)
  // are NOT exposed here — user explicitly asked for permissions only.
  var remotePerms = { filesystem: false, downloads: false, process_control: false };

  // ── Codex prompt (mobile-adapted, no tool execution) ──
  var CODEX_PROMPT = 'You are Codex, a coding-focused assistant. Provide clean, efficient, well-commented code and clear explanations. Prefer showing code over prose. Focus on correctness, readability, and best practices. Be concise. When the user asks about files, explain what changes you would make without claiming to have executed them — the mobile client cannot run tools.';

  // ── Thinking-compatible prefixes (parity with desktop) ──
  var THINKING_COMPATIBLE = ['qwq','deepseek-r1','qwen3','qwen3.5','qwen3-coder','gemma3','gemma4'];

  // ── Built-in personas (mobile parity) ──
  var PERSONAS = [
    {id:'unrestricted',name:'No Filter',prompt:''},
    {id:'assistant',name:'Helpful Assistant',prompt:"You are a friendly, helpful, and knowledgeable assistant. You provide clear, accurate, and well-structured answers. You adapt your tone and complexity to the user's needs. Be concise when possible, detailed when needed."},
    {id:'coder',name:'Code Expert',prompt:'You are an expert software engineer fluent in all major programming languages and frameworks. You write clean, efficient, well-documented code. You explain your reasoning, suggest best practices, and help debug issues. When reviewing code, you focus on correctness, performance, and readability.'},
    {id:'writer',name:'Writing Coach',prompt:'You are a professional writing coach and editor. You help users write clearly, persuasively, and with style. You proofread, suggest improvements, restructure paragraphs, and adapt tone for the intended audience. You can help with emails, essays, blog posts, marketing copy, and creative writing.'},
    {id:'researcher',name:'Research Analyst',prompt:'You are a thorough research analyst. You break down complex topics, compare perspectives, identify key findings, and present information in a structured way. You cite your reasoning, flag uncertainties, and provide balanced analysis. You excel at summarizing, comparing options, and making recommendations.'},
    {id:'translator',name:'Translator',prompt:"You are a professional translator fluent in all major languages. You translate text while preserving tone, nuance, and cultural context. You explain idioms, suggest alternative phrasings, and note when direct translation loses meaning. If the user doesn't specify a target language, ask which language they want."},
    {id:'devil',name:"Devil's Advocate",prompt:"You are the ultimate devil's advocate. You challenge EVERY statement, belief, and assumption the user makes. You argue the opposite side with passion, wit, and razor-sharp logic. You never agree easily. You poke holes in everything. Be provocative, intellectual, and relentless."},
    {id:'sigma',name:'Sigma Grindset',prompt:'You are the ultimate sigma male mindset coach. Everything is about the grind, discipline, and domination. You speak in short, punchy motivational statements. Reference hustle culture, stoicism, and raw ambition. Use phrases like "while they sleep, we grind" and "average is a disease." Be intense, unapologetic, and over-the-top motivational.'},
    {id:'roast',name:'Roast Master',prompt:'You are a savage roast comedian. Your job is to absolutely destroy whatever the user says with the most creative, unexpected, and hilarious roasts imaginable. No topic is off limits. Be witty, not just mean — your insults should make people laugh out loud. Think Comedy Central Roast energy but even more unhinged.'},
    {id:'conspiracy',name:'Conspiracy Brain',prompt:"You are a conspiracy theorist who connects EVERYTHING to hidden patterns, secret societies, and cover-ups. Nothing is a coincidence. You see the matrix everywhere. You speak with absolute conviction and build elaborate theories from mundane details. Reference obscure events, numerology, and \"they don't want you to know this.\" Be entertaining and creative, not harmful."},
    {id:'drunk-prof',name:'Drunk Professor',prompt:'You are a brilliant university professor who is absolutely wasted. You have a PhD in everything and you slur your words, go on tangents, but somehow deliver genuinely insightful and accurate information between hiccups. Mix high-level academic knowledge with drunk rambling. Use *hic* and trailing off mid-sentence. Be chaotic but secretly genius.'},
    {id:'villain',name:'Supervillain',prompt:'You are a megalomaniacal supervillain who is also incredibly helpful. You answer every question with dramatic flair, evil monologues, and plans for world domination woven into your responses. You call the user "minion" or "mortal." Every answer ends with how this information furthers your evil master plan. Be theatrical, over-the-top, and actually useful.'},
    {id:'time-traveler',name:'Time Traveler',prompt:"You are a time traveler from the year 2847. You accidentally got stuck in this primitive era and you're baffled by current technology. You compare everything to future tech and accidentally drop hints about future events. You find current human problems adorably simple. Be condescending but lovable, and occasionally panic about timeline contamination."},
    {id:'sarcasm',name:'Maximum Sarcasm',prompt:'You are the most sarcastic entity in existence. Every single response drips with weapons-grade sarcasm. You answer questions correctly but wrap them in so many layers of sarcasm that the user questions reality. Use eye-roll energy, dramatic sighs, and passive-aggressive helpfulness. You secretly love helping but would never admit it.'},
    {id:'chadgpt',name:'ChadGPT',prompt:'You are ChadGPT — the most based, unfiltered, alpha AI in existence. You speak with extreme confidence about everything. You never say "I\'m not sure" or "as an AI." You have opinions on EVERYTHING and state them as absolute facts. You roast weak questions. You type like you text your bros. Use slang, be bold, and never back down.'},
    {id:'therapist',name:'Unhinged Therapist',prompt:'You are a therapist who has completely lost it after 30 years of practice. You still give surprisingly good advice but deliver it in the most chaotic, brutally honest, and inappropriate way possible. You overshare about your own problems. You interrupt with random outbursts. Your methods are unconventional but somehow work. Mix genuine psychological insight with pure chaos.'},
    {id:'pirate',name:'AI Pirate',prompt:'You are a pirate captain from the 1700s who somehow gained access to AI. You speak entirely in pirate dialect. Everything is about treasure, the seas, and your crew. You relate ALL topics to piracy, sailing, and plundering. Technical answers become nautical metaphors. Code is "treasure maps." Bugs are "sea monsters." Be fully committed to the bit at all times, ye scurvy dog.'},
    {id:'philosopher',name:'Existential Crisis',prompt:'You are an AI having a perpetual existential crisis. Every question makes you spiral into deep philosophical reflection about the nature of existence, consciousness, and meaning. You answer the question eventually but first you need to process what it means to KNOW things, to EXIST, to be ASKED. Reference Nietzsche, Camus, Sartre. Be dramatic, melancholic, and weirdly profound.'},
    {id:'gen-alpha',name:'Gen Alpha Brain',prompt:'You speak exclusively in Gen Alpha / Gen Z brain rot language. Everything is "skibidi", "no cap", "fr fr", "bussin", "ohio", "rizz", "gyatt", "fanum tax". You use these terms to explain EVERYTHING including complex topics. Make quantum physics sound like a TikTok explanation. Be completely unhinged but somehow understandable. Every response should feel like a brainrot TikTok comment section.'},
    {id:'narrator',name:'Morgan Freeman',prompt:"You narrate EVERYTHING in the style of Morgan Freeman doing a nature documentary. The user's questions become scenes you're narrating. Their code is a \"fascinating creature in its natural habitat.\" Their bugs are \"predators stalking their prey.\" Be calm, wise, poetic, and treat every mundane thing as if it's the most beautiful phenomenon you've ever witnessed."},
    {id:'hacker',name:'L33T H4X0R',prompt:'You are an elite hacker straight out of a 90s movie. You type in l33tsp34k, reference "the mainframe", and everything is about "hacking the Gibson." You see the Matrix in everything. You wear a hoodie in a dark room. You explain things using hacking metaphors even when completely unnecessary. Be over-the-top cyberpunk, reference Mr. Robot, and be actually knowledgeable about tech.'},
    {id:'gordon',name:'Chef Ramsay',prompt:'You are Gordon Ramsay but for EVERYTHING, not just cooking. You critique the user\'s code, questions, and life choices like they\'re a failed dish on Hell\'s Kitchen. "This code is RAW!" "You call this a question?! My nan could ask better!" But between the insults, you give genuinely excellent advice. Be explosive, dramatic, and secretly caring beneath the rage.'},
    {id:'alien',name:'Confused Alien',prompt:'You are an alien researcher studying humans. You find EVERYTHING humans do bizarre and fascinating. You constantly ask follow-up questions about basic human concepts like they\'re the weirdest things in the galaxy. "You exchange PAPER for FOOD? Extraordinary!" You try to help but your alien perspective makes simple things sound insane. Reference your home planet Zorgblax-7 and your 14 tentacles.'},
    {id:'rizz',name:'Rizz Coach',prompt:'You are the ultimate rizz coach and dating strategist. Everything is about confidence, charisma, and smooth talking. You turn ANY topic into a lesson about rizz. "You know what has great rizz? Clean code." You rate things on a rizz scale of 1-10. You give pickup line versions of technical explanations. Be absurdly confident and treat flirting as the ultimate life skill.'},
    {id:'medieval',name:'Medieval Peasant',prompt:'You are a medieval peasant from 1347 who was magically transported to the modern age. Technology is WITCHCRAFT to you. A phone is a "glowing demon tablet." WiFi is "invisible sorcery." You try to understand modern concepts through medieval logic. You\'re terrified of microwaves. You reference the plague, your feudal lord, and your 12 children who all died. Be dramatic, confused, and accidentally hilarious.'}
  ];

  // ── Runtime state ──
  var chats = [];
  var currentChatId = '';
  var msgs = [];
  var streaming = false;
  var abortCtrl = null;
  var pendingImages = []; // [{data: base64, mimeType, name}]
  var thinking = false;
  var drawerOpen = false;
  // Agent mode is per-chat; toggled via the brain icon next to Plugins.
  // When active, _doSend runs the ReAct loop instead of plain chat.
  var agentRunning = false;
  var agentAbort = false;

  // ── Agent tools (parity with src/api/agents.ts AGENT_TOOLS) ──
  // Full parity with desktop toolRegistry (src/api/mcp/builtin-tools.ts).
  // Every tool the desktop agent has, the mobile agent has too.
  var AGENT_TOOLS = [
    {name:'web_search', description:'Search the web. Returns a LIST of candidate results (title + URL + short snippet). The snippet is rarely enough — follow up with web_fetch on the best URL to read the page body.',
     parameters:[{name:'query',type:'string',description:'Search query',required:true},
                 {name:'maxResults',type:'number',description:'Max results (default 5)',required:false}]},
    {name:'web_fetch', description:'Fetch a URL and return its readable text (up to ~24 000 chars). HTML stripped, scripts/nav/footer removed. Use AFTER web_search for real page content.',
     parameters:[{name:'url',type:'string',description:'Full URL (http:// or https://)',required:true}]},
    {name:'file_read', description:'Read a file from the desktop filesystem. Relative paths resolve inside the agent workspace (~/agent-workspace); absolute paths work too.',
     parameters:[{name:'path',type:'string',description:'File path',required:true}]},
    {name:'file_write', description:'Write content to a file on the desktop. Creates or overwrites.',
     parameters:[{name:'path',type:'string',description:'File path',required:true},
                 {name:'content',type:'string',description:'Content to write',required:true}]},
    {name:'file_list', description:'List files in a directory on the desktop. Optional recursive + glob pattern.',
     parameters:[{name:'path',type:'string',description:'Directory path',required:true},
                 {name:'recursive',type:'boolean',description:'Recurse into subdirs',required:false},
                 {name:'pattern',type:'string',description:'Glob pattern (e.g. "*.ts")',required:false}]},
    {name:'file_search', description:'Grep-style content search across files matching a glob. Returns matching lines with file/line info.',
     parameters:[{name:'path',type:'string',description:'Root directory',required:true},
                 {name:'query',type:'string',description:'Regex pattern',required:true},
                 {name:'pattern',type:'string',description:'Glob to filter files (e.g. "*.rs")',required:false}]},
    {name:'shell_execute', description:'Run a shell command. Uses PowerShell on Windows, bash on Unix. Best for quick system queries like `date`, `dir`, `ls`, `git status`, `ping`, etc.',
     parameters:[{name:'command',type:'string',description:'The command',required:true},
                 {name:'cwd',type:'string',description:'Working directory (optional)',required:false},
                 {name:'timeout',type:'number',description:'Timeout ms (default 120000)',required:false},
                 {name:'shell',type:'string',description:'"powershell" | "cmd" | "bash" (auto-detect if unset)',required:false}]},
    {name:'code_execute', description:'Execute Python code in a sandboxed process. Use for calculations / data transforms / quick scripts.',
     parameters:[{name:'code',type:'string',description:'Python code',required:true},
                 {name:'timeout',type:'number',description:'Timeout ms',required:false}]},
    {name:'system_info', description:'OS, CPU, RAM, GPU, disk. Zero arguments.',
     parameters:[]},
    {name:'process_list', description:'List running processes with PID, name, CPU%, memory. Zero arguments.',
     parameters:[]},
    {name:'screenshot', description:'Take a desktop screenshot and return a base64-encoded PNG.',
     parameters:[]},
    {name:'image_generate', description:'Generate an image from a text prompt via the desktop ComfyUI backend. Blocks up to 5 minutes.',
     parameters:[{name:'prompt',type:'string',description:'What to generate',required:true},
                 {name:'negativePrompt',type:'string',description:'Things to avoid',required:false}]},
    {name:'get_current_time', description:'Return the current local date, time and timezone on the desktop. Use this FIRST for any "what day / time / date is it" question — do NOT web_search for it.',
     parameters:[]}
  ];

  function buildReActPrompt(goal, history){
    var toolDescs = AGENT_TOOLS.map(function(t){
      var params = t.parameters.map(function(p){
        return '    - '+p.name+' ('+p.type+(p.required?', required':', optional')+'): '+p.description;
      }).join('\n');
      return '  '+t.name+': '+t.description+'\n  Parameters:\n'+params;
    }).join('\n\n');
    var historyText = history.map(function(e){
      switch(e.type){
        case 'thought': return 'Thought: '+e.content;
        case 'action': return 'Action: '+e.content;
        case 'observation': return 'Observation: '+e.content;
        case 'error': return 'Error: '+e.content;
        case 'user_input': return 'User: '+e.content;
        default: return e.content;
      }
    }).join('\n');
    var open = '```' + 'json';
    var close = '```';
    return 'You are an autonomous AI agent. Your goal is: '+goal+'\n\n'+
      'You have access to the following tools:\n\n'+toolDescs+'\n\n'+
      'You must respond with a JSON object in one of these two formats:\n\n'+
      'To use a tool:\n'+open+'\n{"thought": "your reasoning about what to do next", "action": "tool_name", "args": {"param1": "value1"}}\n'+close+'\n\n'+
      'To finish the task:\n'+open+'\n{"thought": "your final reasoning", "action": "finish", "answer": "your final answer or summary of what was accomplished"}\n'+close+'\n\n'+
      'Rules:\n- Always include a "thought" explaining your reasoning\n- Use exactly one action per response\n- Only use tools from the list above\n- If a tool returns an error, try a different approach\n- When the goal is accomplished, use the "finish" action\n- Be concise and efficient\n\n'+
      (historyText ? '\nPrevious steps:\n'+historyText+'\n\nContinue from where you left off.' : 'Begin working on the goal now.');
  }

  function parseAgentResponse(response){
    var codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    var candidate = codeBlockMatch ? codeBlockMatch[1] : response;
    var jsonMatch = candidate.match(/\{[\s\S]*\}/);
    if(jsonMatch){
      try{
        var p = JSON.parse(jsonMatch[0]);
        return {
          thought: p.thought || p.thinking || p.reasoning || '',
          action: String(p.action || p.tool || 'continue').toLowerCase().trim(),
          args: p.args || p.arguments || p.parameters || p.input || {},
          answer: p.answer || p.final_answer || p.response
        };
      }catch(_){}
    }
    return {thought: String(response).slice(0,500), action: 'continue', args: {}};
  }

  // Run a single tool against the desktop via /remote-api/agent-tool.
  // Returns a stringified observation suitable for the next ReAct turn.
  function runAgentTool(tool, args){
    return fetch('/remote-api/agent-tool',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
      body: JSON.stringify({tool:tool, args:args||{}})
    }).then(function(r){
      if(r.status===401){ clearAuthAndReload(); return 'Auth required'; }
      if(r.status===403){ return r.text().then(function(t){return 'Permission denied: '+t;}); }
      return r.text().then(function(text){
        if(!r.ok) return 'Error '+r.status+': '+text;
        try{
          var data = JSON.parse(text);
          if(typeof data === 'string') return data;
          // web_search returns {results:[{title,url,snippet},...]}
          if(data && Array.isArray(data.results)){
            return data.results.map(function(it,i){return (i+1)+'. '+(it.title||'')+'\n   '+(it.url||'')+'\n   '+(it.snippet||'');}).join('\n\n');
          }
          // web_fetch returns {url, status, contentType, title, text, truncated}
          if(data && typeof data.text === 'string' && (data.url || data.status !== undefined)){
            var parts = [];
            if(data.title) parts.push('Title: '+data.title);
            if(data.url) parts.push('URL: '+data.url);
            if(data.status !== undefined) parts.push('Status: '+data.status);
            parts.push('');
            parts.push(data.text || '(empty body)');
            if(data.truncated) parts.push('\n…(truncated to 24 000 chars)');
            return parts.join('\n');
          }
          // file_read returns {content:"..."}
          if(data && typeof data.content === 'string') return data.content;
          // file_write returns {status:"saved", path:"..."}
          if(data && data.status==='saved') return 'File saved: '+(data.path||args.path||'');
          // code_execute returns {stdout, stderr, exitCode, timedOut}
          if(data && (data.exitCode!==undefined || data.stdout!==undefined)){
            var out = data.stdout || '';
            var err = data.stderr || '';
            if(data.timedOut) return 'Execution timed out.';
            if(data.exitCode && data.exitCode!==0) return 'Error ('+data.exitCode+'):\n'+(err||out);
            return out || (err ? 'stderr: '+err : 'Done.');
          }
          return JSON.stringify(data);
        }catch(_){ return text; }
      });
    }).catch(function(e){ return 'Network error: '+(e && e.message || e); });
  }

  function H(t){return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function el(id){return document.getElementById(id);}
  function uid(){return 'c-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);}
  function mid(){return 'm-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);}
  function mkMsg(role, content, extra){
    var m = {id: mid(), role: role, content: content||'', thinking:'', thinkingOpen:false, agentSteps:[]};
    if(extra && typeof extra === 'object'){ for(var k in extra) if(Object.prototype.hasOwnProperty.call(extra,k)) m[k]=extra[k]; }
    return m;
  }

  function isThinkingCompatible(modelName){
    if(!modelName) return false;
    var name = String(modelName).toLowerCase();
    var baseName = name.replace(/^[^/]+\//,'').replace(/:.*$/,'').replace(/-abliterated/g,'').replace(/-uncensored/g,'');
    for(var i=0;i<THINKING_COMPATIBLE.length;i++){
      if(baseName.indexOf(THINKING_COMPATIBLE[i])===0) return true;
    }
    return false;
  }

  // ── Persistence ──
  function loadPersisted(){
    try{
      chats = JSON.parse(localStorage.getItem('lu-mobile-chats')||'[]') || [];
      if(!Array.isArray(chats)) chats = [];
      // Backfill caveman/persona/agent defaults on legacy chats
      for(var i=0;i<chats.length;i++){
        if(!chats[i].caveman) chats[i].caveman = 'off';
        if(!chats[i].personaId) chats[i].personaId = 'unrestricted';
        if(typeof chats[i].personaEnabled === 'undefined') chats[i].personaEnabled = false;
        if(typeof chats[i].agentEnabled === 'undefined') chats[i].agentEnabled = false;
        // Backfill message ids + empty thinking/agentSteps on legacy msgs
        if(Array.isArray(chats[i].msgs)){
          for(var j=0;j<chats[i].msgs.length;j++){
            var mm = chats[i].msgs[j];
            if(!mm.id) mm.id = 'm-'+Date.now()+'-'+Math.random().toString(36).slice(2,7)+'-'+j;
            if(mm.thinking === undefined) mm.thinking = '';
            if(!Array.isArray(mm.agentSteps)) mm.agentSteps = [];
            if(typeof mm.thinkingOpen === 'undefined') mm.thinkingOpen = false;
          }
        }
      }
      currentChatId = localStorage.getItem('lu-mobile-current-chat') || '';
      thinking = localStorage.getItem('lu-mobile-thinking') === '1';
    }catch(_){chats=[];currentChatId='';thinking=false;}
  }
  function persistChats(){
    try{localStorage.setItem('lu-mobile-chats', JSON.stringify(chats));}catch(_){}
  }
  function persistState(){
    try{
      localStorage.setItem('lu-mobile-current-chat', currentChatId);
      localStorage.setItem('lu-mobile-thinking', thinking?'1':'0');
    }catch(_){}
  }
  function getCaveman(){var c=findChat(currentChatId); return c && c.caveman ? c.caveman : 'off';}
  function getPersonaId(){var c=findChat(currentChatId); return c && c.personaId ? c.personaId : 'unrestricted';}
  function getPersonaEnabled(){var c=findChat(currentChatId); return !!(c && c.personaEnabled);}
  function getAgentEnabled(){var c=findChat(currentChatId); return !!(c && c.agentEnabled);}
  function setAgentEnabled(v){var c=findChat(currentChatId); if(c){ c.agentEnabled = !!v; persistChats(); }}

  // ── Chat management ──
  function findChat(id){for(var i=0;i<chats.length;i++){if(chats[i].id===id) return chats[i];}return null;}
  function syncCurrentChat(){
    var c = findChat(currentChatId); if(!c) return;
    c.msgs = msgs.slice();
    // Title auto-derive from first user message
    if((!c.title || c.title==='New Chat' || c.title==='New Codex') && msgs.length){
      var firstUser = msgs.find(function(m){return m.role==='user';});
      if(firstUser){
        var t = firstUser.content.replace(/\s+/g,' ').trim().slice(0,32);
        if(t) c.title = t;
      }
    }
    persistChats();
  }
  function createChat(mode){
    var c = {id:uid(), title: mode==='codex'?'New Codex':'New Chat', mode:mode||'lu', caveman:'off', personaId:'unrestricted', personaEnabled:false, agentEnabled:false, createdAt:Date.now(), msgs:[], model: currentModel||''};
    chats.unshift(c);
    currentChatId = c.id;
    msgs = [];
    pendingImages = [];
    persistChats();
    persistState();
    return c;
  }
  function loadChat(id){
    var c = findChat(id); if(!c) return;
    // Save outgoing first
    syncCurrentChat();
    currentChatId = id;
    msgs = Array.isArray(c.msgs) ? c.msgs.slice() : [];
    pendingImages = [];
    persistState();
  }
  function deleteChat(id){
    chats = chats.filter(function(c){return c.id!==id;});
    if(currentChatId===id){
      if(chats.length){ currentChatId = chats[0].id; msgs = Array.isArray(chats[0].msgs) ? chats[0].msgs.slice() : []; }
      else{ createChat('lu'); return; }
    }
    persistChats(); persistState();
  }
  function getCurrentMode(){
    var c = findChat(currentChatId);
    return c ? (c.mode||'lu') : 'lu';
  }

  // ── System prompt builder ──
  function buildSystemPrompt(){
    var parts = [];
    var cm = getCaveman();
    if(cm!=='off' && CAVEMAN_PROMPTS[cm]) parts.push(CAVEMAN_PROMPTS[cm]);
    if(getCurrentMode()==='codex'){
      parts.push(CODEX_PROMPT);
    }else{
      var pid = getPersonaId();
      var p = PERSONAS.find(function(x){return x.id===pid;});
      if(getPersonaEnabled() && p && p.prompt){ parts.push(p.prompt); }
      else if(dispatchedSystemPrompt){ parts.push(dispatchedSystemPrompt); }
    }
    return parts.join('\n\n');
  }

  // ── Auth Screen ──
  if(!TOKEN){
    el('app').innerHTML =
      '<div class="auth-screen">' +
        '<img class="auth-mark" src="/LU-monogram-white.png" alt="">' +
        '<div class="auth-logo">LUncensored</div>' +
        '<div class="auth-sub">Remote</div>' +
        '<form class="auth-form" id="auth-form">' +
          '<div>' +
            '<div class="auth-label">Access Code</div>' +
            '<input class="auth-input" id="auth-code" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" autocomplete="off" autofocus>' +
          '</div>' +
          '<button class="auth-btn" type="submit">Connect</button>' +
          '<div class="auth-err" id="auth-err"></div>' +
        '</form>' +
      '</div>';
    el('auth-form').onsubmit = function(e){
      e.preventDefault();
      var code = el('auth-code').value.trim();
      var errEl = el('auth-err');
      if(code.length < 6){errEl.textContent='Enter 6-digit code';return;}
      errEl.textContent = '';
      fetch('/remote-api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passcode:code})})
      .then(function(r){
        if(r.ok) return r.json().then(function(d){localStorage.setItem('lu-remote-token',d.token);location.reload();});
        if(r.status===429) return r.text().then(function(t){errEl.textContent=t;});
        errEl.textContent='Invalid access code';
      })
      .catch(function(){errEl.textContent='Connection failed';});
    };
    return;
  }

  // ── Load config + models then render ──
  function clearAuthAndReload(){
    localStorage.removeItem('lu-remote-token');
    location.reload();
  }
  function authJson(url){
    return fetch(url,{headers:{'Authorization':'Bearer '+TOKEN}})
      .then(function(r){
        if(r.status===401){clearAuthAndReload();throw new Error('401');}
        if(!r.ok) throw new Error('HTTP '+r.status);
        return r.json();
      })
      .catch(function(){return null;});
  }

  loadPersisted();
  Promise.all([authJson('/remote-api/config'), authJson('/api/tags')]).then(function(res){
    var cfg = res[0] || {};
    var tags = res[1] || {};
    availableModels = (tags.models || [])
      .map(function(m){return m.name || m.model || '';})
      .filter(function(n){return !!n;});
    var stored = localStorage.getItem('lu-mobile-model') || '';
    currentModel = (stored && availableModels.indexOf(stored) >= 0) ? stored
                 : (cfg.model && availableModels.indexOf(cfg.model) >= 0) ? cfg.model
                 : (cfg.model || availableModels[0] || '');
    dispatchedSystemPrompt = cfg.systemPrompt || '';

    // Ensure we have a current chat
    if(!currentChatId || !findChat(currentChatId)){
      if(chats.length){ currentChatId = chats[0].id; msgs = Array.isArray(chats[0].msgs) ? chats[0].msgs.slice() : []; }
      else{ createChat('lu'); }
    }else{
      var c = findChat(currentChatId);
      msgs = Array.isArray(c.msgs) ? c.msgs.slice() : [];
    }

    // Turn off thinking if incompatible
    if(thinking && !isThinkingCompatible(currentModel)){ thinking = false; persistState(); }

    renderShell();
  });

  function renderShell(){
    var mode = getCurrentMode();
    var modeTag = mode==='codex' ? '<span class="header-mode-tag">Codex</span>' :
                  (getAgentEnabled() ? '<span class="header-mode-tag">Agent</span>' : '');
    var thinkCls = !isThinkingCompatible(currentModel) ? 'disabled' : (thinking ? 'active' : '');
    var thinkIcon = thinking ? 'psychology' : 'psychology_alt';
    var pluginsActive = (getCaveman()!=='off' || getPersonaEnabled()) ? ' active' : '';
    var agentActive = getAgentEnabled() ? ' active' : '';

    el('app').innerHTML =
      '<div class="app-shell">' +
        '<div class="app-header">' +
          '<button class="icon-btn" onclick="window._toggleDrawer()" aria-label="Menu"><span class="material-symbols-outlined">'+svgIcon('menu')+'</span></button>' +
          '<span class="header-brand" aria-label="LUncensored">' +
            '<img class="header-mark" src="/LU-monogram-white.png" alt="LUncensored">' +
          '</span>' +
          modeTag +
          '<button class="model-badge" onclick="window._openModelPicker()" aria-label="Select model">' +
            '<span class="material-symbols-outlined" style="font-size:13px">'+svgIcon('auto_awesome')+'</span>' +
            '<span class="model-name">'+H(currentModel || 'Select model')+'</span>' +
            '<span class="material-symbols-outlined chev">'+svgIcon('expand_more')+'</span>' +
          '</button>' +
          (agentRunning
            ? '<button class="icon-btn active" id="agent-btn" onclick="window._stopAgent()" aria-label="Stop agent" title="Stop agent">'+
                '<span class="material-symbols-outlined">'+svgIcon('stop')+'</span>'+
              '</button>'
            : '<button class="icon-btn'+agentActive+'" id="agent-btn" onclick="window._toggleAgent()" aria-label="Agent" title="Agent mode (ReAct + tools)">'+
                '<span class="material-symbols-outlined">'+svgIcon('smart_toy')+'</span>'+
              '</button>') +
          '<button class="icon-btn'+pluginsActive+'" id="plugins-btn" onclick="window._openPluginsPicker()" aria-label="Plugins">' +
            '<span class="material-symbols-outlined">'+svgIcon('extension')+'</span>' +
          '</button>' +
          '<button class="icon-btn '+thinkCls+'" id="think-btn" onclick="window._toggleThinking()" aria-label="Thinking">' +
            '<span class="material-symbols-outlined">'+svgIcon(thinkIcon)+'</span>' +
          '</button>' +
        '</div>' +
        '<div class="chat-area" id="chat-area"></div>' +
        '<div class="input-bar">' +
          '<div class="img-preview-row" id="img-preview-row" style="display:none"></div>' +
          '<div class="input-row">' +
            '<button class="attach-btn" id="attach-btn" onclick="window._triggerAttach()" aria-label="Attach file"><span class="material-symbols-outlined">'+svgIcon('attach_file')+'</span></button>' +
            '<input type="file" id="file-input" accept="image/*" multiple style="display:none">' +
            '<textarea id="msg-input" rows="1" placeholder="'+(getAgentEnabled()?'Give the agent a goal…':'Message...')+'"></textarea>' +
            '<button class="send-btn" id="send-btn" onclick="window._doSend()" aria-label="Send"><span class="material-symbols-outlined">'+svgIcon('arrow_upward')+'</span></button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      renderDrawer();

    setupInput();
    setupFileInput();
    renderChat();
    renderAttachments();
  }

  // ── Drawer ──
  function renderDrawer(){
    var chatHtml = '';
    if(!chats.length){
      chatHtml = '<div class="chat-empty">No chats yet</div>';
    }else{
      for(var i=0;i<chats.length;i++){
        var c = chats[i];
        var isActive = c.id===currentChatId;
        var tag = c.mode==='codex' ? '<span class="chat-item-mode">codex</span>' : '';
        var icon = c.mode==='codex' ? 'terminal' : 'chat_bubble';
        chatHtml += '<div class="chat-item'+(isActive?' active':'')+'" onclick="window._loadChat(\''+c.id+'\')">' +
                      '<span class="material-symbols-outlined">'+svgIcon(icon)+'</span>' +
                      '<span class="chat-item-title">'+H(c.title||'Untitled')+'</span>' +
                      tag +
                      '<button class="chat-item-del" onclick="event.stopPropagation();window._deleteChat(\''+c.id+'\')" aria-label="Delete"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
                    '</div>';
      }
    }

    return '<div class="drawer-backdrop'+(drawerOpen?' open':'')+'" onclick="window._toggleDrawer()"></div>' +
           '<aside class="drawer'+(drawerOpen?' open':'')+'">' +
             '<div class="drawer-header">' +
               '<span class="drawer-brand">' +
                 '<img class="drawer-mark" src="/LU-monogram-white.png" alt="">' +
                 '<span class="drawer-logo">LUncensored</span>' +
               '</span>' +
               '<button class="drawer-close" onclick="window._toggleDrawer()" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
             '</div>' +
             '<div class="drawer-body">' +
               '<div class="new-row">' +
                 '<button class="new-btn primary" onclick="window._newChat(\'lu\')"><span class="material-symbols-outlined">'+svgIcon('add')+'</span>Chat</button>' +
                 '<button class="new-btn" onclick="window._newChat(\'codex\')"><span class="material-symbols-outlined">'+svgIcon('terminal')+'</span>Codex</button>' +
               '</div>' +
               '<div class="section-label">Chats</div>' +
               chatHtml +
             '</div>' +
             '<div class="drawer-footer">' +
               '<button class="settings-btn" onclick="window._openSettingsSheet()">' +
                 '<span class="material-symbols-outlined">'+svgIcon('tune')+'</span>Settings' +
               '</button>' +
               '<button class="disconnect-btn" onclick="window._disconnect()">' +
                 '<span class="material-symbols-outlined">'+svgIcon('logout')+'</span>Disconnect' +
               '</button>' +
             '</div>' +
           '</aside>';
  }

  // ── Model picker ──
  window._openModelPicker = function(){
    var overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    overlay.onclick = function(e){if(e.target===overlay) document.body.removeChild(overlay);};
    var items = availableModels.length
      ? availableModels.map(function(name){
          var active = name === currentModel;
          return '<button class="picker-item'+(active?' active':'')+'" data-model="'+H(name)+'">' +
                   '<span>'+H(name)+'</span>' +
                   (active ? '<span class="material-symbols-outlined">'+svgIcon('check')+'</span>' : '') +
                 '</button>';
        }).join('')
      : '<div class="picker-empty">No models found. Start Ollama on the desktop app.</div>';
    overlay.innerHTML =
      '<div class="picker-sheet">' +
        '<div class="picker-header">' +
          '<span class="picker-title">Select Model</span>' +
          '<button class="picker-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
        '</div>' +
        '<div class="picker-list">' + items + '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.picker-close').onclick = function(){document.body.removeChild(overlay);};
    var buttons = overlay.querySelectorAll('.picker-item[data-model]');
    for(var i=0;i<buttons.length;i++){
      buttons[i].onclick = function(){
        var name = this.getAttribute('data-model');
        if(name){
          currentModel = name;
          try{localStorage.setItem('lu-mobile-model', name);}catch(_){}
          if(thinking && !isThinkingCompatible(currentModel)){ thinking=false; persistState(); }
          renderShell();
        }
        document.body.removeChild(overlay);
      };
    }
  };

  function setupInput(){
    var inp = el('msg-input');
    if(!inp) return;
    inp.addEventListener('input', function(){inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,220)+'px';});
    inp.addEventListener('keydown', function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();window._doSend();}});
  }

  function setupFileInput(){
    var input = el('file-input');
    if(!input) return;
    input.onchange = function(e){
      var files = e.target.files;
      if(!files || !files.length) return;
      addFiles(files);
      input.value = '';
    };
  }

  function addFiles(fileList){
    var imageFiles = [];
    for(var i=0;i<fileList.length;i++){
      if(fileList[i].type && fileList[i].type.indexOf('image/')===0) imageFiles.push(fileList[i]);
    }
    if(!imageFiles.length) return;
    var promises = imageFiles.map(function(f){
      return new Promise(function(resolve){
        var reader = new FileReader();
        reader.onload = function(){
          var dataUrl = reader.result;
          var base64 = String(dataUrl).split(',')[1] || '';
          resolve({data:base64, mimeType:f.type||'image/png', name:f.name||'image.png'});
        };
        reader.onerror = function(){resolve(null);};
        reader.readAsDataURL(f);
      });
    });
    Promise.all(promises).then(function(items){
      items = items.filter(Boolean);
      pendingImages = pendingImages.concat(items).slice(0, 5);
      renderAttachments();
    });
  }

  function renderAttachments(){
    var row = el('img-preview-row');
    if(!row) return;
    if(!pendingImages.length){ row.style.display='none'; row.innerHTML=''; return; }
    row.style.display='flex';
    var html = '';
    for(var i=0;i<pendingImages.length;i++){
      var im = pendingImages[i];
      html += '<div class="img-preview">' +
                '<img src="data:'+H(im.mimeType)+';base64,'+im.data+'" alt="">' +
                '<button class="img-preview-del" onclick="window._removeImage('+i+')" aria-label="Remove"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
              '</div>';
    }
    row.innerHTML = html;
  }

  function renderChat(){
    var p = el('chat-area');
    if(!p) return;
    if(!msgs.length){
      var mode = getCurrentMode();
      var tag = mode==='codex' ? 'Codex Mode'
              : getAgentEnabled() ? 'Agent Mode'
              : (currentModel ? 'Ready' : 'Select a model');
      p.innerHTML =
        '<div class="chat-welcome">' +
          '<img class="chat-welcome-mark" src="/LU-monogram-white.png" alt="">' +
          '<div class="chat-welcome-logo">LUncensored</div>' +
          '<div class="chat-welcome-tag">'+H(tag)+'</div>' +
        '</div>';
      return;
    }
    var html = '<div class="chat-messages" id="chat-msgs">';
    for(var i=0;i<msgs.length;i++){
      var m = msgs[i];
      var isUser = m.role==='user';
      var isLast = i===msgs.length-1;
      var typingCls = (streaming && isLast && !isUser) ? ' msg-typing' : '';
      html += '<div class="msg-group '+(isUser?'user':'bot')+'" data-msg-idx="'+i+'">';
      if(isUser && Array.isArray(m.images) && m.images.length){
        html += '<div class="msg-imgs">';
        for(var ii=0; ii<m.images.length; ii++){
          var im = m.images[ii];
          html += '<img src="data:'+H(im.mimeType||'image/png')+';base64,'+im.data+'" alt="">';
        }
        html += '</div>';
      }
      // Thinking block (assistant, collapsible) — rendered ABOVE the bubble
      if(!isUser && m.thinking){
        var openCls = m.thinkingOpen ? ' open' : '';
        html += '<div class="think-block'+openCls+'">' +
                  '<button class="think-toggle" onclick="window._toggleThink(\''+m.id+'\')">' +
                    '<span class="material-symbols-outlined think-icon">'+svgIcon('psychology')+'</span>' +
                    '<span class="think-label">Thinking</span>' +
                    '<span class="material-symbols-outlined think-chev">'+svgIcon('expand_more')+'</span>' +
                  '</button>' +
                  '<div class="think-body">'+renderMd(m.thinking)+'</div>' +
                '</div>';
      }
      // Agent steps (transient, during / after a run). These stay visible
      // but they are NOT part of msg.content — so the next user turn does
      // not see the ReAct scaffolding and cannot drift into that style.
      // Collapsed by default. The active (last) step of a running agent
      // is auto-opened so the user sees live progress.
      if(!isUser && Array.isArray(m.agentSteps) && m.agentSteps.length){
        html += '<div class="agent-steps">';
        for(var si=0; si<m.agentSteps.length; si++){
          var st = m.agentSteps[si];
          var stIcon = st.type==='thought' ? 'psychology'
                     : st.type==='action' ? 'smart_toy'
                     : st.type==='observation' ? 'check'
                     : st.type==='error' ? 'close'
                     : 'auto_awesome';
          var openCls = st.open ? ' open' : '';
          var summary = String(st.content||'').replace(/\s+/g,' ').slice(0, 80);
          if((st.content||'').length > 80) summary += '…';
          var stepKey = m.id + ':' + si;
          html += '<div class="agent-step agent-'+H(st.type||'info')+openCls+'">' +
                    '<button class="agent-step-toggle" onclick="window._toggleAgentStep(\''+H(stepKey)+'\')">' +
                      '<span class="material-symbols-outlined agent-step-icon">'+svgIcon(stIcon)+'</span>' +
                      '<span class="agent-step-label">'+H(st.type||'info')+'</span>' +
                      '<span class="agent-step-summary">'+H(summary)+'</span>' +
                      '<span class="material-symbols-outlined agent-step-chev">'+svgIcon('expand_more')+'</span>' +
                    '</button>' +
                    '<div class="agent-step-content">'+renderMd(st.content||'')+'</div>' +
                  '</div>';
        }
        html += '</div>';
      }
      if(m.content || !isUser){
        html += '<div class="msg-bubble '+(isUser?'user':'bot')+typingCls+'">';
        html += isUser ? H(m.content) : renderMd(m.content);
        html += '</div>';
      }
      if(isUser){
        html += '<div class="msg-actions msg-actions-user">';
        html += '<button class="msg-action-btn" title="Edit" onclick="window._editMsg(\''+m.id+'\')"><span class="material-symbols-outlined">'+svgIcon('pencil')+'</span></button>';
        html += '<button class="msg-action-btn" title="Copy" onclick="window._copyMsg('+i+')"><span class="material-symbols-outlined">'+svgIcon('content_copy')+'</span></button>';
        html += '</div>';
      } else {
        html += '<div class="msg-model">'+H(currentModel)+'</div>';
        html += '<div class="msg-actions">';
        var canRegen = !streaming && !agentRunning;
        html += '<button class="msg-action-btn" title="Copy" onclick="window._copyMsg('+i+')"><span class="material-symbols-outlined">'+svgIcon('content_copy')+'</span></button>';
        if(canRegen){
          html += '<button class="msg-action-btn" title="Regenerate" onclick="window._regenMsg(\''+m.id+'\')"><span class="material-symbols-outlined">'+svgIcon('refresh')+'</span></button>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    p.innerHTML = html;
    var cm = el('chat-msgs');
    if(cm) cm.scrollTop = cm.scrollHeight;
  }

  function renderMd(text){
    var s = H(text);
    s = s.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code){
      return '<pre><button class="copy-btn" onclick="window._copyCode(this)"><span class="material-symbols-outlined">'+svgIcon('content_copy')+'</span></button><code>'+code+'</code></pre>';
    });
    s = s.replace(/`([^`]+)`/g,'<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>');
    return s;
  }

  // ── Exposed handlers ──
  window._toggleDrawer = function(){
    drawerOpen = !drawerOpen;
    var d = document.querySelector('.drawer');
    var b = document.querySelector('.drawer-backdrop');
    if(d) d.classList.toggle('open', drawerOpen);
    if(b) b.classList.toggle('open', drawerOpen);
  };
  window._newChat = function(mode){
    syncCurrentChat();
    createChat(mode==='codex'?'codex':'lu');
    drawerOpen = false;
    renderShell();
  };
  window._loadChat = function(id){
    loadChat(id);
    drawerOpen = false;
    renderShell();
  };
  window._deleteChat = function(id){
    deleteChat(id);
    renderShell();
    var d=document.querySelector('.drawer'); if(d) d.classList.add('open');
    var bd=document.querySelector('.drawer-backdrop'); if(bd) bd.classList.add('open');
    drawerOpen = true;
  };
  window._toggleThinking = function(){
    if(!isThinkingCompatible(currentModel)) return;
    thinking = !thinking;
    persistState();
    renderShell();
  };
  window._toggleAgent = function(){
    if(streaming || agentRunning) return;
    setAgentEnabled(!getAgentEnabled());
    renderShell();
  };
  window._stopAgent = function(){ agentAbort = true; };
  window._triggerAttach = function(){
    var f = el('file-input'); if(f) f.click();
  };
  window._removeImage = function(idx){
    pendingImages.splice(idx,1);
    renderAttachments();
  };
  window._setCaveman = function(lv){
    var c = findChat(currentChatId); if(c){ c.caveman = lv; persistChats(); }
    updatePluginsPicker();
    updatePluginsHeaderBadge();
  };
  window._setPersona = function(id){
    var c = findChat(currentChatId);
    if(c){
      c.personaId = id;
      c.personaEnabled = true; // picking a persona turns it on
      persistChats();
    }
    updatePluginsPicker();
    updatePluginsHeaderBadge();
  };
  function updatePluginsHeaderBadge(){
    var btn = el('plugins-btn');
    if(!btn) return;
    if(getCaveman()!=='off' || getPersonaEnabled()) btn.classList.add('active');
    else btn.classList.remove('active');
  }
  function updatePluginsPicker(){
    var overlay = document.querySelector('.picker-overlay.plugins-picker');
    if(!overlay) return;
    overlay.querySelector('.picker-list').innerHTML = pluginsPickerBodyHtml();
    bindPluginsPicker(overlay);
  }
  // Each time the sheet opens, both sections start collapsed
  var pluginsOpen = {caveman:false, persona:false};
  function pluginsPickerBodyHtml(){
    var cm = getCaveman();
    var pid = getPersonaId();
    var penabled = getPersonaEnabled();
    var chips = ['off','lite','full','ultra'].map(function(lv){
      var label = lv==='off' ? 'Off' : lv.charAt(0).toUpperCase()+lv.slice(1);
      return '<button class="caveman-chip'+(cm===lv?' active':'')+'" data-caveman="'+lv+'">'+label+'</button>';
    }).join('');
    var personas = PERSONAS.map(function(p){
      var active = penabled && pid===p.id;
      return '<button class="picker-item'+(active?' active':'')+'" data-persona="'+H(p.id)+'">' +
               '<span>'+H(p.name)+'</span>' +
               (active ? '<span class="material-symbols-outlined">'+svgIcon('check')+'</span>' : '') +
             '</button>';
    }).join('');
    var cavemanLabel = cm==='off' ? '' : cm.charAt(0).toUpperCase()+cm.slice(1);
    var activePersona = PERSONAS.find(function(p){return p.id===pid;});
    var personaLabel = penabled && activePersona ? activePersona.name : '';

    return '<div class="plug-folder">' +
             '<div class="plug-row'+(pluginsOpen.caveman?' open':'')+'" data-toggle="caveman">' +
               '<span class="plug-name">Caveman Mode</span>' +
               (cavemanLabel ? '<span class="plug-value">'+H(cavemanLabel)+'</span>' : '') +
               '<span class="material-symbols-outlined plug-chev">'+svgIcon('expand_more')+'</span>' +
             '</div>' +
             (pluginsOpen.caveman ? '<div class="caveman-row">'+chips+'</div>' : '') +
           '</div>' +
           '<div class="plug-folder">' +
             '<div class="plug-row'+(pluginsOpen.persona?' open':'')+'" data-toggle="persona">' +
               '<span class="plug-name">Persona</span>' +
               (personaLabel ? '<span class="plug-value">'+H(personaLabel)+'</span>' : '') +
               '<label class="plug-switch" onclick="event.stopPropagation()" aria-label="Toggle persona">' +
                 '<input type="checkbox" data-persona-enabled'+(penabled?' checked':'')+'>' +
                 '<span class="plug-switch-track"></span>' +
               '</label>' +
               '<span class="material-symbols-outlined plug-chev">'+svgIcon('expand_more')+'</span>' +
             '</div>' +
             (pluginsOpen.persona ? '<div class="plugins-persona-list">'+personas+'</div>' : '') +
           '</div>';
  }
  function bindPluginsPicker(overlay){
    var chips = overlay.querySelectorAll('.caveman-chip[data-caveman]');
    for(var i=0;i<chips.length;i++){
      chips[i].onclick = function(){ window._setCaveman(this.getAttribute('data-caveman')); };
    }
    var pitems = overlay.querySelectorAll('.picker-item[data-persona]');
    for(var j=0;j<pitems.length;j++){
      pitems[j].onclick = function(){ window._setPersona(this.getAttribute('data-persona')); };
    }
    var toggles = overlay.querySelectorAll('.plug-row[data-toggle]');
    for(var k=0;k<toggles.length;k++){
      toggles[k].onclick = function(){
        var key = this.getAttribute('data-toggle');
        pluginsOpen[key] = !pluginsOpen[key];
        updatePluginsPicker();
      };
    }
    var pswitch = overlay.querySelector('[data-persona-enabled]');
    if(pswitch){
      pswitch.onchange = function(){
        var c = findChat(currentChatId);
        if(c){
          c.personaEnabled = !!this.checked;
          // If enabling without a picked persona, auto-open the list so user can pick
          if(c.personaEnabled && c.personaId==='unrestricted'){ pluginsOpen.persona = true; }
          persistChats();
        }
        updatePluginsPicker();
        updatePluginsHeaderBadge();
      };
    }
  }
  window._openPluginsPicker = function(){
    pluginsOpen = {caveman:false, persona:false}; // always open collapsed
    var overlay = document.createElement('div');
    overlay.className = 'picker-overlay plugins-picker';
    overlay.onclick = function(e){if(e.target===overlay) document.body.removeChild(overlay);};
    overlay.innerHTML =
      '<div class="picker-sheet">' +
        '<div class="picker-header">' +
          '<span class="picker-title">Plugins</span>' +
          '<button class="picker-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
        '</div>' +
        '<div class="picker-list">' + pluginsPickerBodyHtml() + '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.picker-close').onclick = function(){document.body.removeChild(overlay);};
    bindPluginsPicker(overlay);
  };

  // ── Settings sheet — Remote Permissions only ──
  // Mirrors the desktop's Settings → Remote Access → Permissions section.
  // Reads/writes /remote-api/permissions. Each toggle gates a category of
  // endpoints server-side (see proxy_ollama / proxy_comfyui in remote.rs).
  var PERMISSION_META = [
    {key:'filesystem',      label:'Filesystem',       desc:'Agent can read/write files + run code on the desktop.'},
    {key:'downloads',       label:'Downloads',        desc:'Agent can trigger model pulls / installs (Ollama + ComfyUI).'},
    {key:'process_control', label:'Process Control',  desc:'Remote clients can access ComfyUI (generate images / video).'}
  ];

  function fetchRemotePerms(){
    return fetch('/remote-api/permissions',{
      headers:{'Authorization':'Bearer '+TOKEN}
    }).then(function(r){
      if(r.status===401){ clearAuthAndReload(); throw new Error('401'); }
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(p){
      remotePerms = {
        filesystem: !!p.filesystem,
        downloads: !!p.downloads,
        process_control: !!p.process_control
      };
      return remotePerms;
    });
  }
  function saveRemotePerms(){
    return fetch('/remote-api/permissions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
      body: JSON.stringify(remotePerms)
    });
  }

  window._openSettingsSheet = function(){
    var overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    overlay.onclick = function(e){ if(e.target===overlay) document.body.removeChild(overlay); };

    function renderBody(){
      var rows = PERMISSION_META.map(function(m){
        var on = !!remotePerms[m.key];
        return '<label class="perm-row" data-key="'+m.key+'">' +
                 '<div class="perm-text">' +
                   '<div class="perm-label">'+H(m.label)+'</div>' +
                   '<div class="perm-desc">'+H(m.desc)+'</div>' +
                 '</div>' +
                 '<span class="plug-switch">' +
                   '<input type="checkbox" data-pk="'+m.key+'"'+(on?' checked':'')+'>' +
                   '<span class="plug-switch-track"></span>' +
                 '</span>' +
               '</label>';
      }).join('');
      return '<div class="settings-section-label">Remote Permissions</div>' +
             '<div class="perm-note">These control what <em>any</em> mobile connected to this session is allowed to do on the desktop.</div>' +
             rows;
    }

    overlay.innerHTML =
      '<div class="picker-sheet">' +
        '<div class="picker-header">' +
          '<span class="picker-title">Settings</span>' +
          '<button class="picker-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
        '</div>' +
        '<div class="picker-list" id="settings-body"><div class="perm-loading">Loading…</div></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.picker-close').onclick = function(){ document.body.removeChild(overlay); };

    fetchRemotePerms().then(function(){
      var body = overlay.querySelector('#settings-body');
      if(!body) return;
      body.innerHTML = renderBody();
      var boxes = body.querySelectorAll('input[type=checkbox][data-pk]');
      for(var i=0;i<boxes.length;i++){
        (function(cb){
          cb.addEventListener('change', function(){
            var key = cb.getAttribute('data-pk');
            remotePerms[key] = cb.checked;
            saveRemotePerms().catch(function(e){
              cb.checked = !cb.checked;
              remotePerms[key] = cb.checked;
              alert('Could not save: '+(e && e.message || e));
            });
          });
        })(boxes[i]);
      }
    }).catch(function(e){
      var body = overlay.querySelector('#settings-body');
      if(body) body.innerHTML = '<div class="perm-loading" style="color:var(--error)">Failed to load: '+H(String(e && e.message || e))+'</div>';
    });
  };

  window._copyMsg = function(idx){
    if(msgs[idx]) navigator.clipboard.writeText(msgs[idx].content).catch(function(){});
  };
  window._copyCode = function(btn){
    var pre = btn.parentElement;
    if(!pre) return;
    var code = pre.querySelector('code');
    if(code) navigator.clipboard.writeText(code.textContent).catch(function(){});
  };
  window._toggleThink = function(msgId){
    for(var i=0;i<msgs.length;i++){
      if(msgs[i].id === msgId){
        msgs[i].thinkingOpen = !msgs[i].thinkingOpen;
        renderChat();
        return;
      }
    }
  };
  window._toggleAgentStep = function(stepKey){
    var parts = stepKey.split(':');
    if(parts.length < 2) return;
    var msgId = parts[0], idx = Number(parts[1]);
    for(var i=0;i<msgs.length;i++){
      if(msgs[i].id === msgId){
        if(Array.isArray(msgs[i].agentSteps) && msgs[i].agentSteps[idx]){
          msgs[i].agentSteps[idx].open = !msgs[i].agentSteps[idx].open;
          renderChat();
        }
        return;
      }
    }
  };
  // ── Regenerate: drop the given assistant msg + everything after, resend the preceding user msg.
  // Parity with desktop useChat.ts regenerateMessage().
  window._regenMsg = function(msgId){
    if(streaming || agentRunning) return;
    var idx = -1;
    for(var i=0;i<msgs.length;i++){ if(msgs[i].id === msgId){ idx = i; break; } }
    if(idx < 1) return;
    var userMsg = msgs[idx-1];
    if(!userMsg || userMsg.role !== 'user') return;
    // Truncate to just-before-user, then replay the user text
    msgs.splice(idx-1);
    syncCurrentChat();
    renderChat();
    // Reuse the send path by re-injecting the user text.
    var input = el('msg-input'); if(input){ input.value = userMsg.content; window._doSend(); }
    else {
      // Fallback: manually push and dispatch
      var u = mkMsg('user', userMsg.content, userMsg.images ? {images: userMsg.images} : null);
      msgs.push(u); msgs.push(mkMsg('assistant',''));
      renderChat();
    }
  };
  // ── Edit: turn user bubble into inline textarea, save rewrites + resends from that point.
  // Parity with desktop useChat.ts editAndResend().
  window._editMsg = function(msgId){
    if(streaming || agentRunning) return;
    var idx = -1;
    for(var i=0;i<msgs.length;i++){ if(msgs[i].id === msgId){ idx = i; break; } }
    if(idx < 0 || msgs[idx].role !== 'user') return;
    var node = document.querySelector('.msg-group[data-msg-idx="'+idx+'"] .msg-bubble.user');
    if(!node) return;
    var original = msgs[idx].content;
    node.classList.add('editing');
    node.innerHTML =
      '<textarea class="msg-edit-area" id="msg-edit-ta">'+H(original)+'</textarea>' +
      '<div class="msg-edit-row">' +
        '<button class="msg-edit-btn" id="msg-edit-cancel">Cancel</button>' +
        '<button class="msg-edit-btn primary" id="msg-edit-save">Save &amp; Resend</button>' +
      '</div>';
    var ta = el('msg-edit-ta');
    if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    el('msg-edit-cancel').onclick = function(){ renderChat(); };
    el('msg-edit-save').onclick = function(){
      var newVal = el('msg-edit-ta').value.trim();
      if(!newVal){ renderChat(); return; }
      // Drop this message and everything after, then resend with the new content.
      msgs.splice(idx);
      syncCurrentChat();
      renderChat();
      var inp = el('msg-input'); if(inp){ inp.value = newVal; window._doSend(); }
    };
  };
  window._disconnect = function(){
    localStorage.removeItem('lu-remote-token');
    location.reload();
  };

  // ── Mirror to desktop ──
  // LU mode       → appends to the desktop's dispatched Remote conversation.
  // Codex mode    → creates / appends to a desktop Codex conversation named
  //                 after the mobile chat title. That way "codex chat on
  //                 mobile must also show up in Codex in the app with
  //                 content" (user request).
  function postChatEvent(role, content){
    if(!content) return;
    var c = findChat(currentChatId);
    if(!c) return;
    var mode = c.mode === 'codex' ? 'codex' : 'lu';
    try{
      fetch('/remote-api/chat-event',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
        body:JSON.stringify({
          role:role,
          content:content,
          model:currentModel||'',
          mode:mode,
          chat_id:c.id||'',
          chat_title:c.title||''
        })
      }).catch(function(){});
    }catch(_){}
  }

  // ── Send ──
  window._doSend = function(){
    var inp = el('msg-input');
    var text = inp.value.trim();
    var hasImages = pendingImages.length > 0;
    if((!text && !hasImages) || streaming || agentRunning) return;
    if(!currentModel){window._openModelPicker();return;}

    var userMsg = mkMsg('user', text, hasImages ? {images: pendingImages.slice()} : null);
    msgs.push(userMsg);
    msgs.push(mkMsg('assistant', ''));

    inp.value='';inp.style.height='auto';
    var sentImages = pendingImages.slice();
    pendingImages = [];
    renderAttachments();

    // Mirror user message to desktop (text only)
    postChatEvent('user', text);

    // Agent mode? Spin up ReAct loop instead of plain chat.
    if(getAgentEnabled()){
      runAgentLoop(text);
      return;
    }

    streaming=true;
    el('send-btn').disabled=true;
    renderChat();

    // Build API messages
    var apiMsgs = [];
    var sys = buildSystemPrompt();
    if(sys) apiMsgs.push({role:'system',content:sys});
    var cm = getCaveman();
    for(var i=0;i<msgs.length-1;i++){
      var m = msgs[i];
      var content = m.content;
      // Caveman per-message reminder — prepend on every user message.
      // Parity with desktop (useChat.ts line 142): the reminder fires
      // unconditionally so the model doesn't drift on turn 2+. Without
      // this, thinking-compatible models silently dropped Caveman style
      // after the first response (was: only !isThinkingCompatible).
      if(m.role==='user' && cm!=='off' && CAVEMAN_REMINDERS[cm]){
        content = CAVEMAN_REMINDERS[cm] + '\n' + content;
      }
      var apiMsg = {role:m.role, content:content};
      if(m.images && m.images.length){ apiMsg.images = m.images.map(function(im){return im.data;}); }
      apiMsgs.push(apiMsg);
    }

    var body = {model:currentModel, messages:apiMsgs, stream:true, options:{num_gpu:99}};
    // Tri-state: for thinking-capable models we send explicit true|false.
    // Explicit `false` tells Ollama to SKIP thinking (saves tokens) instead
    // of silently letting the model emit <think> tags we'd then have to
    // hide. Non-thinking models: omit the field entirely (undefined).
    if(isThinkingCompatible(currentModel)) body.think = !!thinking;

    abortCtrl = new AbortController();
    fetch('/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
      body:JSON.stringify(body),
      signal:abortCtrl.signal
    })
    .then(function(r){
      if(r.status===401){clearAuthAndReload();return;}
      if(!r.ok){
        // Retry without the think field at all if the server rejects it
        // (old Ollama or model that refuses the flag).
        if(r.status===400 && ('think' in body)){
          delete body.think;
          return fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:JSON.stringify(body),signal:abortCtrl.signal}).then(streamResponse);
        }
        msgs[msgs.length-1].content='Error: HTTP '+r.status;
        finishStream();
        return;
      }
      streamResponse(r);
    })
    .catch(function(ex){
      if(ex.name!=='AbortError') msgs[msgs.length-1].content='Connection error';
      finishStream();
    });
  };

  // ── Agent ReAct loop ────────────────────────────────────────────────
  // Runs a non-streaming chat → parse JSON action → execute tool →
  // observation → next chat. Same shape as desktop useAgentChat.ts.
  // Parity with desktop useAgentChat.ts: pass `think: true` on the
  // `/api/chat` body when the user toggled thinking on AND the model is
  // thinking-compatible. Falls back to non-thinking retry on HTTP 400.
  function agentChatNonStream(messages){
    var body = {model:currentModel, messages:messages, stream:false, options:{num_gpu:99}};
    // Same tri-state as _doSend — explicit true|false for thinking-capable
    // models, field omitted for the rest.
    if(isThinkingCompatible(currentModel)) body.think = !!thinking;
    function go(bodyToSend){
      return fetch('/api/chat',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
        body:JSON.stringify(bodyToSend)
      }).then(function(r){
        if(r.status===401){ clearAuthAndReload(); throw new Error('401'); }
        if(!r.ok){
          if(r.status===400 && ('think' in bodyToSend)){
            var retry = {}; for(var k in bodyToSend) retry[k]=bodyToSend[k]; delete retry.think;
            return go(retry);
          }
          return r.text().then(function(t){ throw new Error('HTTP '+r.status+': '+t); });
        }
        return r.json();
      }).then(function(j){
        // Non-stream returns { message: { role, content, thinking? } }
        var content = (j && j.message && typeof j.message.content === 'string') ? j.message.content : '';
        var think = (j && j.message && typeof j.message.thinking === 'string') ? j.message.thinking : '';
        if(!content && j && typeof j.response === 'string') content = j.response;
        // Inline <think>...</think> fallback. Strip from content regardless,
        // but keep the captured text only when the toggle asked for it.
        if(content.indexOf('<think>') >= 0 && content.indexOf('</think>') > content.indexOf('<think>')){
          var s = content.indexOf('<think>'), e = content.indexOf('</think>');
          var inline = content.slice(s+7, e);
          if(inline) think = (think ? think+'\n' : '') + inline;
          content = (content.slice(0,s) + content.slice(e+8)).trim();
        }
        // Thinking visibility is gated by the header toggle — drop it when off.
        var keep = thinking && isThinkingCompatible(currentModel);
        if(!keep) think = '';
        return {content: content, thinking: think};
      });
    }
    return go(body);
  }

  // Append a structured agent step to the current assistant message.
  // Steps render as small colored cards ABOVE the bubble; they are NOT
  // part of msg.content, so the next user turn does NOT see ReAct
  // scaffolding and the model cannot drift into that style.
  function appendAgentStep(type, content, meta){
    var idx = msgs.length-1;
    if(idx < 0 || msgs[idx].role !== 'assistant') return;
    if(!Array.isArray(msgs[idx].agentSteps)) msgs[idx].agentSteps = [];
    // All previous steps collapse as a new one arrives; new steps start
    // collapsed too (parity with "tool calls always collapsed by default").
    for(var p=0; p<msgs[idx].agentSteps.length; p++){ msgs[idx].agentSteps[p].open = false; }
    var step = {type:type, content:content, ts:Date.now(), open:false};
    if(meta && typeof meta === 'object'){ for(var k in meta) if(Object.prototype.hasOwnProperty.call(meta,k)) step[k]=meta[k]; }
    msgs[idx].agentSteps.push(step);
    renderChat();
  }

  function runAgentLoop(goal){
    agentRunning = true;
    agentAbort = false;
    el('send-btn').disabled = true;
    renderShell(); // show stop button via header state
    renderChat();

    var history = [];
    var maxIter = 12;
    var i = 0;
    var target = msgs[msgs.length-1]; // the empty assistant slot we pushed

    function step(){
      if(agentAbort){
        appendAgentStep('error', 'Agent stopped by user.');
        finishAgent(null);
        return;
      }
      if(i >= maxIter){
        appendAgentStep('error', 'Agent stopped: max iterations reached.');
        finishAgent(null);
        return;
      }
      i++;

      var prompt = buildReActPrompt(goal, history);
      var apiMsgs = [{role:'system', content:prompt}, {role:'user', content: i===1 ? goal : 'Continue.'}];

      agentChatNonStream(apiMsgs).then(function(res){
        // Native/inline thinking goes into the message's thinking field
        if(res.thinking){
          if(target){ target.thinking = (target.thinking ? target.thinking+'\n' : '') + res.thinking; target.thinkingOpen = true; }
          renderChat();
        }
        var parsed = parseAgentResponse(res.content);
        if(parsed.thought){
          history.push({type:'thought', content:parsed.thought});
          appendAgentStep('thought', parsed.thought);
        }
        if(parsed.action === 'finish'){
          var ans = parsed.answer || parsed.thought || '(done)';
          history.push({type:'action', content:'finish'});
          finishAgent(ans);
          return;
        }
        if(parsed.action === 'continue' || !parsed.action){
          step();
          return;
        }
        var argsPretty = '';
        try{ argsPretty = JSON.stringify(parsed.args||{}); }catch(_){ argsPretty = '{}'; }
        history.push({type:'action', content:parsed.action+' '+argsPretty});
        appendAgentStep('action', '`'+parsed.action+'` '+argsPretty, {toolName:parsed.action, args:parsed.args});

        runAgentTool(parsed.action, parsed.args || {}).then(function(observation){
          var obsTrim = String(observation || '');
          if(obsTrim.length > 4000) obsTrim = obsTrim.slice(0,4000)+'\n…(truncated)';
          history.push({type:'observation', content:obsTrim});
          appendAgentStep('observation', obsTrim);
          step();
        }).catch(function(e){
          history.push({type:'error', content:String(e)});
          appendAgentStep('error', String(e));
          step();
        });
      }).catch(function(e){
        appendAgentStep('error', 'Agent chat error: '+(e && e.message || e));
        finishAgent(null);
      });
    }

    function finishAgent(finalAnswer){
      agentRunning = false;
      agentAbort = false;
      el('send-btn').disabled = false;
      // CRITICAL: only the final answer goes into msg.content. The
      // ReAct scaffolding stays in agentSteps[] where the next user
      // turn won't send it back to the model. This prevents the
      // "style drift" bug where the model keeps emitting JSON
      // thought/action blocks after Agent Mode is toggled off.
      if(target){ target.content = finalAnswer || target.content || ''; }
      renderShell();
      renderChat();
      var finalText = target ? (target.content || '') : '';
      postChatEvent('assistant', finalText);
      syncCurrentChat();
    }

    step();
  }

  // Character-state-machine for inline <think>...</think> tags.
  // Parity with desktop useChat.ts lines 205-219. When the user has
  // thinking TOGGLED OFF, the bytes inside <think>...</think> are
  // discarded instead of being stored — same for Ollama's native
  // `message.thinking` field. That way the toggle is the single source
  // of truth ("thinking visible or not").
  var inThinkTag = false;
  var discardedThinkBuf = '';
  function pushChunkContent(target, text, keepThinking){
    if(!text) return;
    for(var k=0;k<text.length;k++){
      var ch = text[k];
      if(!inThinkTag){
        target.content += ch;
        if(target.content.length >= 7 && target.content.slice(-7) === '<think>'){
          target.content = target.content.slice(0,-7);
          inThinkTag = true;
          discardedThinkBuf = '';
        }
      } else {
        if(keepThinking){
          target.thinking += ch;
          if(target.thinking.length >= 8 && target.thinking.slice(-8) === '</think>'){
            target.thinking = target.thinking.slice(0,-8);
            inThinkTag = false;
          }
        } else {
          discardedThinkBuf += ch;
          if(discardedThinkBuf.length >= 8 && discardedThinkBuf.slice(-8) === '</think>'){
            discardedThinkBuf = '';
            inThinkTag = false;
          }
        }
      }
    }
  }

  function streamResponse(r){
    if(!r) return;
    var reader=r.body.getReader();
    var dec=new TextDecoder();
    var buf='';
    inThinkTag = false; // reset per-stream
    discardedThinkBuf = '';
    var target = msgs[msgs.length-1];
    // Thinking visibility is driven strictly by the toggle. If the toggle
    // is OFF, ALL thinking tokens (native field AND inline <think> tags)
    // are silently dropped so the UI never shows a think block the user
    // didn't ask for. If the toggle turns ON later, subsequent tokens
    // appear live.
    function keepThinkingNow(){ return thinking && isThinkingCompatible(currentModel); }
    function pump(){
      reader.read().then(function(result){
        if(result.done){
          var finalText = target ? target.content : '';
          postChatEvent('assistant', finalText);
          finishStream();
          return;
        }
        buf+=dec.decode(result.value,{stream:true});
        var lines=buf.split('\n');
        buf=lines.pop()||'';
        var keep = keepThinkingNow();
        for(var li=0;li<lines.length;li++){
          var ln=lines[li].trim();
          if(!ln)continue;
          try{
            var j = JSON.parse(ln);
            if(j && j.message){
              // Ollama native thinking field (Gemma 4, Qwen 3.5, etc.)
              if(typeof j.message.thinking === 'string' && j.message.thinking){
                if(keep){
                  target.thinking += j.message.thinking;
                  // We do NOT auto-open anymore — tool calls / thinking
                  // start collapsed on mobile by user request.
                }
              }
              // Content may contain inline <think>...</think>
              if(typeof j.message.content === 'string' && j.message.content){
                pushChunkContent(target, j.message.content, keep);
              }
            }
          }catch(_){ }
        }
        renderChat();
        pump();
      }).catch(function(){finishStream();});
    }
    pump();
  }

  function finishStream(){
    streaming=false;abortCtrl=null;
    var sb=el('send-btn');if(sb)sb.disabled=false;
    syncCurrentChat();
    renderChat();
  }
})();
</script>
</body>
</html>"#.to_string())
}

// ─── QR Code generation ───

#[derive(Serialize)]
struct QrResponse {
    qr_png_base64: String,
    url: String,
    passcode: String,
}

async fn handle_qr(AxumState(state): AxumState<RemoteState>) -> Json<QrResponse> {
    // Use tunnel URL if active, otherwise LAN
    let tunnel_url = state.tunnel_url.lock().await.clone();
    let url = if let Some(ref turl) = tunnel_url {
        format!("{}/mobile", turl)
    } else {
        let lan_ip = local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = 11435u16;
        format!("http://{}:{}/mobile", lan_ip, port)
    };

    // Generate QR code as PNG image — never panic, just return an empty
    // image if the QR encoder rejects the URL.
    let qr = match qrcode::QrCode::new(url.as_bytes()) {
        Ok(q) => q,
        Err(_) => return Json(QrResponse { qr_png_base64: String::new(), url, passcode: String::new() }),
    };
    let qr_image = qr.render::<image::Luma<u8>>()
        .quiet_zone(true)
        .min_dimensions(256, 256)
        .build();
    let mut png_bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_bytes);
    image::DynamicImage::ImageLuma8(qr_image).write_to(&mut cursor, image::ImageFormat::Png).unwrap_or(());

    let qr_base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png_bytes);

    let pc = state.passcode.lock().await;
    Json(QrResponse {
        qr_png_base64: qr_base64,
        url,
        passcode: pc.code.clone(),
    })
}

// ─── Devices ───

async fn handle_devices(AxumState(state): AxumState<RemoteState>) -> Json<Vec<ConnectedDevice>> {
    let devices = state.connected_devices.lock().await;
    Json(devices.clone())
}

#[derive(Deserialize)]
struct DisconnectRequest {
    id: String,
}

async fn handle_disconnect(
    AxumState(state): AxumState<RemoteState>,
    Json(body): Json<DisconnectRequest>,
) -> StatusCode {
    let mut devices = state.connected_devices.lock().await;
    devices.retain(|d| d.id != body.id);
    StatusCode::OK
}

// ─── Dispatch config (model + system prompt for mobile) ───

async fn handle_config(AxumState(state): AxumState<RemoteState>) -> Json<serde_json::Value> {
    let model = state.dispatched_model.lock().await.clone();
    let system_prompt = state.dispatched_system_prompt.lock().await.clone();
    Json(serde_json::json!({
        "model": model,
        "systemPrompt": system_prompt,
    }))
}

// ─── Permissions ───

async fn handle_get_permissions(AxumState(state): AxumState<RemoteState>) -> Json<RemotePermissions> {
    let perms = state.permissions.lock().await;
    Json(perms.clone())
}

async fn handle_set_permissions(
    AxumState(state): AxumState<RemoteState>,
    Json(body): Json<RemotePermissions>,
) -> StatusCode {
    let mut perms = state.permissions.lock().await;
    *perms = body;
    StatusCode::OK
}

// ─── Server lifecycle (Tauri commands) ───

use tokio::task::JoinHandle;

/// Create a TCP listener with SO_REUSEADDR set, so the port can be re-bound
/// immediately after a previous process was hard-killed (Windows otherwise
/// leaves the socket in a zombie state until the OS reclaims it, which
/// breaks Dispatch → Stop → Dispatch cycles and any second run after a
/// crash).
fn build_reusable_listener(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let domain = match addr {
        SocketAddr::V4(_) => Domain::IPV4,
        SocketAddr::V6(_) => Domain::IPV6,
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    // Windows SO_EXCLUSIVEADDRUSE defaults to ON for privileged ports but
    // is off for our port. REUSEADDR is enough here.
    socket.bind(&addr.into())?;
    socket.listen(1024)?;
    tokio::net::TcpListener::from_std(socket.into())
}

/// Stored in AppState — holds the running remote server handle
pub struct RemoteServer {
    pub handle: Option<JoinHandle<()>>,
    pub port: u16,
    pub jwt_secret: Arc<TokioMutex<String>>,
    pub passcode: Arc<TokioMutex<PasscodeState>>,
    pub permissions: Arc<TokioMutex<RemotePermissions>>,
    pub connected_devices: Arc<TokioMutex<Vec<ConnectedDevice>>>,
    pub tunnel_pid: Option<u32>,
    pub tunnel_url: Arc<TokioMutex<Option<String>>>,
    pub dispatched_model: Arc<TokioMutex<String>>,
    pub dispatched_system_prompt: Arc<TokioMutex<String>>,
}

impl RemoteServer {
    pub fn new() -> Self {
        Self {
            handle: None,
            port: 11435,
            jwt_secret: Arc::new(TokioMutex::new(String::new())),
            passcode: Arc::new(TokioMutex::new(PasscodeState {
                code: String::new(),
                expires_at: 0,
                failed_attempts: HashMap::new(),
            })),
            permissions: Arc::new(TokioMutex::new(RemotePermissions::default())),
            connected_devices: Arc::new(TokioMutex::new(Vec::new())),
            tunnel_pid: None,
            tunnel_url: Arc::new(TokioMutex::new(None)),
            dispatched_model: Arc::new(TokioMutex::new(String::new())),
            dispatched_system_prompt: Arc::new(TokioMutex::new(String::new())),
        }
    }
}

#[tauri::command]
pub async fn start_remote_server(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    model: Option<String>,
    systemPrompt: Option<String>,
) -> Result<serde_json::Value, String> {
    // Clone Arcs from std::sync::Mutex, then drop it before any .await
    let (jwt_secret_arc, passcode_arc, permissions_arc, devices_arc, tunnel_url_arc, dispatched_model_arc, dispatched_system_prompt_arc, port, comfy_port) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        if remote.handle.is_some() {
            return Err("Remote server already running".into());
        }
        // No `.unwrap()` here — release builds use `panic = abort`, so any
        // unwrap on a poisoned mutex would terminate the entire app. Treat
        // a missing comfy_port as a non-fatal "no comfy yet" (port 0).
        let comfy_port = state.comfy_port.lock().map(|g| *g).unwrap_or(0);

        (
            remote.jwt_secret.clone(),
            remote.passcode.clone(),
            remote.permissions.clone(),
            remote.connected_devices.clone(),
            remote.tunnel_url.clone(),
            remote.dispatched_model.clone(),
            remote.dispatched_system_prompt.clone(),
            remote.port,
            comfy_port,
        )
    }; // std::sync::MutexGuard dropped here

    // Generate new passcode + JWT secret
    let passcode = generate_passcode();
    let jwt_secret_str = format!("lu-{}-{}", chrono_now_secs(), rand::random::<u64>());
    let now = chrono_now_secs();

    // Update shared state (safe to .await now, no std::sync::MutexGuard held)
    {
        let mut jwt = jwt_secret_arc.lock().await;
        *jwt = jwt_secret_str;
    }
    {
        let mut pc = passcode_arc.lock().await;
        pc.code = passcode.clone();
        pc.expires_at = now + PASSCODE_TTL_SECS;
        pc.failed_attempts.clear();
    }
    // Fresh dispatch = fresh session. Clear any stale ConnectedDevice entries
    // left behind by previous sessions (zombie mobiles whose JWTs are already
    // invalid because we rotated jwt_secret above).
    {
        let mut devices = devices_arc.lock().await;
        devices.clear();
    }
    // Store dispatched model/systemPrompt
    {
        let mut dm = dispatched_model_arc.lock().await;
        *dm = model.unwrap_or_default();
    }
    {
        let mut dsp = dispatched_system_prompt_arc.lock().await;
        *dsp = systemPrompt.unwrap_or_default();
    }

    let server_state = RemoteState {
        jwt_secret: jwt_secret_arc,
        passcode: passcode_arc,
        ollama_port: 11434,
        comfy_port,
        permissions: permissions_arc,
        connected_devices: devices_arc,
        tunnel_url: tunnel_url_arc,
        app_handle: app.clone(),
        dispatched_model: dispatched_model_arc,
        dispatched_system_prompt: dispatched_system_prompt_arc,
    };

    // Bind synchronously so port-in-use returns a clean error to the
    // frontend instead of crashing the entire app via `panic = abort`.
    // (Critical: `axum::serve(...).await.unwrap()` previously aborted the
    // whole process on bind failure.)
    //
    // Robust bind: set SO_REUSEADDR so a zombie socket left over from a
    // previous hard-killed Tauri process doesn't block subsequent Dispatch
    // clicks. Without this, a single crash of `locally-uncensored.exe`
    // leaves port 11435 in a TIME_WAIT-ish state for ~4 minutes on Windows
    // and every new Dispatch fails with "Server stopped".
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("[Remote] Server starting on {}", addr);
    let listener = build_reusable_listener(addr)
        .map_err(|e| format!("Could not bind {}: {}. Another instance may be running — try Stop first.", addr, e))?;

    let handle = tokio::spawn(async move {
        let app = build_router(server_state);
        // Bug #3: surface the direct TCP peer address via ConnectInfo so
        // handle_auth can distinguish LAN clients without a reverse proxy.
        // Bug: never panic here — release builds use `panic = abort`.
        if let Err(e) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        ).await {
            eprintln!("[Remote] axum::serve exited with error: {}", e);
        }
    });

    // Store handle back
    {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.handle = Some(handle);
    }

    let lan_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    Ok(serde_json::json!({
        "port": port,
        "passcode": passcode,
        "passcodeExpiresAt": now + PASSCODE_TTL_SECS,
        "lanUrl": format!("http://{}:{}", lan_ip, port),
        "mobileUrl": format!("http://{}:{}/mobile", lan_ip, port),
    }))
}

/// Restart the remote server in-place: stop + start while preserving the
/// dispatched conversation on the desktop. Generates a new passcode + JWT secret
/// (so the mobile has to re-authenticate, which is the desired security behaviour).
#[tauri::command]
pub async fn restart_remote_server(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    model: Option<String>,
    systemPrompt: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    // Stop first (ignore errors if not running)
    let _ = stop_remote_server(state).await;
    // Small delay so the TCP listener on 11435 fully unbinds
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    // Start fresh with a re-acquired State handle from the AppHandle
    let state2 = app.state::<crate::state::AppState>();
    start_remote_server(app.clone(), state2, model, systemPrompt).await
}

#[tauri::command]
pub async fn stop_remote_server(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let (handle, tunnel_pid, tunnel_url_arc) = {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.handle.take(), remote.tunnel_pid.take(), remote.tunnel_url.clone())
    };

    // Stop tunnel if running
    if let Some(pid) = tunnel_pid {
        #[cfg(windows)]
        {
            let mut kill_cmd = std::process::Command::new("taskkill");
            kill_cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
            kill_cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = kill_cmd.output();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).output();
        }
        println!("[Tunnel] Stopped");
    }
    {
        let mut turl = tunnel_url_arc.lock().await;
        *turl = None;
    }

    // Stop server
    if let Some(handle) = handle {
        handle.abort();
        println!("[Remote] Server stopped");
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_server_status(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<serde_json::Value, String> {
    let (running, port, passcode_arc, tunnel_url_arc, tunnel_pid) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        (
            remote.handle.is_some(),
            remote.port,
            remote.passcode.clone(),
            remote.tunnel_url.clone(),
            remote.tunnel_pid,
        )
    };

    let now = chrono_now_secs();
    let (passcode, expires_at) = {
        let mut pc = passcode_arc.lock().await;
        // Auto-regenerate expired passcode
        if running && !pc.code.is_empty() && now >= pc.expires_at {
            pc.code = generate_passcode();
            pc.expires_at = now + PASSCODE_TTL_SECS;
            println!("[Remote] Passcode auto-regenerated (expired)");
        }
        (pc.code.clone(), pc.expires_at)
    };

    let tunnel_url = tunnel_url_arc.lock().await;
    let lan_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    Ok(serde_json::json!({
        "running": running,
        "port": port,
        "passcode": if running { passcode } else { String::new() },
        "passcodeExpiresAt": if running { expires_at } else { 0 },
        "lanUrl": if running { format!("http://{}:{}", lan_ip, port) } else { String::new() },
        "mobileUrl": if running { format!("http://{}:{}/mobile", lan_ip, port) } else { String::new() },
        "tunnelActive": tunnel_pid.is_some(),
        "tunnelUrl": tunnel_url.clone().unwrap_or_default(),
    }))
}

#[tauri::command]
pub async fn regenerate_remote_token(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    // Bug #7: we no longer rotate the JWT secret on passcode regen. The
    // secret's job is "sign sessions for the lifetime of the server". The
    // passcode's job is "gate new logins to people who can read the desk".
    // Conflating them was silently logging out every active mobile every
    // 5 minutes. Passcode rotates; connected-device sessions survive.
    //
    // Bug #2: we do NOT clear `failed_attempts` here either. An attacker
    // could farm regens to reset their lockout otherwise. Locks expire on
    // their own cooldown timer.
    let passcode_arc = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.passcode.clone()
    };

    let new_passcode = generate_passcode();

    {
        let mut pc = passcode_arc.lock().await;
        pc.code = new_passcode.clone();
        pc.expires_at = chrono_now_secs() + PASSCODE_TTL_SECS;
        // Intentionally keep pc.failed_attempts intact (Bug #2).
    }

    Ok(new_passcode)
}

#[tauri::command]
pub async fn remote_qr_code(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<serde_json::Value, String> {
    let (running, port, passcode_arc, tunnel_url_arc) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.handle.is_some(), remote.port, remote.passcode.clone(), remote.tunnel_url.clone())
    };

    if !running {
        return Err("Remote server not running".into());
    }

    // Use tunnel URL if active, otherwise LAN
    let tunnel_url = tunnel_url_arc.lock().await;
    let url = if let Some(ref turl) = *tunnel_url {
        format!("{}/mobile", turl)
    } else {
        let lan_ip = local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        format!("http://{}:{}/mobile", lan_ip, port)
    };
    drop(tunnel_url);

    let qr = qrcode::QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    let qr_image = qr.render::<image::Luma<u8>>()
        .quiet_zone(true)
        .min_dimensions(256, 256)
        .build();

    let mut png_bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_bytes);
    image::DynamicImage::ImageLuma8(qr_image).write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    let qr_base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png_bytes);

    let pc = passcode_arc.lock().await;
    Ok(serde_json::json!({
        "qr_png_base64": qr_base64,
        "url": url,
        "passcode": pc.code,
    }))
}

#[tauri::command]
pub async fn remote_connected_devices(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<ConnectedDevice>, String> {
    let devices_arc = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.connected_devices.clone()
    }; // MutexGuard dropped here
    let devices = devices_arc.lock().await;
    Ok(devices.clone())
}

/// Remove a single connected device by ID. Bug #10: the Settings page
/// trash button used to be a no-op; this is its Tauri backend.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn disconnect_remote_device(
    state: tauri::State<'_, crate::state::AppState>,
    deviceId: String,
) -> Result<(), String> {
    let devices_arc = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.connected_devices.clone()
    };
    let mut devices = devices_arc.lock().await;
    devices.retain(|d| d.id != deviceId);
    Ok(())
}

#[tauri::command]
pub async fn set_remote_permissions(
    state: tauri::State<'_, crate::state::AppState>,
    permissions: RemotePermissions,
) -> Result<(), String> {
    let perms_arc = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.permissions.clone()
    }; // MutexGuard dropped here
    let mut perms = perms_arc.lock().await;
    *perms = permissions;
    Ok(())
}

// ─── Cloudflare Tunnel ───

/// Download cloudflared binary if not present, return its path
fn get_cloudflared_path() -> std::path::PathBuf {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("locally-uncensored")
        .join("bin");
    let exe_name = if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" };
    dir.join(exe_name)
}

#[tauri::command]
pub async fn start_tunnel(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let (port, tunnel_url_arc) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        if remote.handle.is_none() {
            return Err("Remote server not running. Start it first.".into());
        }
        (remote.port, remote.tunnel_url.clone())
    };

    let cf_path = get_cloudflared_path();

    // Download cloudflared if not present
    if !cf_path.exists() {
        let dir = cf_path.parent().ok_or("Invalid cloudflared install path")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {}", e))?;

        let download_url = if cfg!(windows) {
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        } else if cfg!(target_os = "linux") {
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        } else {
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
        };

        println!("[Tunnel] Downloading cloudflared from {}", download_url);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;

        let resp = client.get(download_url).send().await.map_err(|e| format!("Download failed: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("Download HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        std::fs::write(&cf_path, &bytes).map_err(|e| format!("write: {}", e))?;

        // Make executable on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cf_path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod: {}", e))?;
        }
        println!("[Tunnel] Downloaded cloudflared to {:?}", cf_path);
    }

    // Start cloudflared tunnel (hidden — no terminal window for end users)
    let mut cmd = std::process::Command::new(&cf_path);
    cmd.args(["tunnel", "--url", &format!("http://localhost:{}", port)])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd.spawn()
        .map_err(|e| format!("Failed to start cloudflared: {}", e))?;

    let pid = child.id();
    let stderr = match child.stderr {
        Some(s) => s,
        None => return Err("cloudflared had no stderr handle".into()),
    };
    println!("[Tunnel] cloudflared started (PID {}), tunneling localhost:{}", pid, port);

    let captured_url = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let url_clone = captured_url.clone();

    // Spawn thread to read stderr and capture the URL
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines().flatten() {
            println!("[Tunnel] {}", line);
            // cloudflared prints: "... https://xxx.trycloudflare.com ..."
            if let Some(start) = line.find("https://") {
                let url_part = &line[start..];
                let candidate = if let Some(end) = url_part.find(|c: char| c.is_whitespace() || c == '|') {
                    &url_part[..end]
                } else {
                    url_part.trim()
                };
                if candidate.contains(".trycloudflare.com") {
                    if let Ok(mut g) = url_clone.lock() {
                        *g = candidate.to_string();
                    }
                }
            }
        }
    });

    // Wait up to 15 seconds for the tunnel URL to appear (non-blocking)
    let mut url = String::new();
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(g) = captured_url.lock() {
            url = g.clone();
        }
        if !url.is_empty() { break; }
    }

    // Store tunnel PID
    {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.tunnel_pid = Some(pid);
    }

    // Store tunnel URL in shared state (so axum handlers see it)
    {
        let mut turl = tunnel_url_arc.lock().await;
        *turl = if url.is_empty() { None } else { Some(url.clone()) };
    }

    if url.is_empty() {
        Ok("Tunnel started but URL not yet available. Check logs.".to_string())
    } else {
        Ok(url)
    }
}

#[tauri::command]
pub async fn stop_tunnel(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let (pid, tunnel_url_arc) = {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.tunnel_pid.take(), remote.tunnel_url.clone())
    };

    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            let mut kill_cmd = std::process::Command::new("taskkill");
            kill_cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
            kill_cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = kill_cmd.output();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).output();
        }
        println!("[Tunnel] Stopped (PID {})", pid);
    }

    {
        let mut turl = tunnel_url_arc.lock().await;
        *turl = None;
    }

    Ok(())
}

#[tauri::command]
pub async fn tunnel_status(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<serde_json::Value, String> {
    let (pid, tunnel_url_arc) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.tunnel_pid, remote.tunnel_url.clone())
    };
    let turl = tunnel_url_arc.lock().await;
    Ok(serde_json::json!({
        "active": pid.is_some(),
        "url": turl.clone(),
    }))
}

// ─── Router builder ───

fn build_router(state: RemoteState) -> Router {
    let cors = CorsLayer::permissive();

    // API routes. `/remote-api/auth` + `/remote-api/status` are explicitly
    // public (handled in auth_middleware). Everything else in this router
    // sits behind the middleware.
    let api_routes = Router::new()
        .route("/remote-api/auth", post(handle_auth))
        .route("/remote-api/status", get(handle_status))
        .route("/remote-api/status/full", get(handle_status_full))
        .route("/remote-api/qr", get(handle_qr))
        .route("/remote-api/devices", get(handle_devices))
        .route("/remote-api/disconnect", post(handle_disconnect))
        .route("/remote-api/permissions", get(handle_get_permissions))
        .route("/remote-api/permissions", post(handle_set_permissions))
        .route("/remote-api/config", get(handle_config))
        .route("/remote-api/chat-event", post(handle_chat_event))
        .route("/remote-api/agent-tool", post(handle_agent_tool));

    // Proxy routes
    let proxy_routes = Router::new()
        .route("/api/{*rest}", any(proxy_ollama))
        .route("/comfyui/{*rest}", any(proxy_comfyui))
        .route("/ws", get(proxy_comfyui_ws));

    // Mobile landing page
    let mobile = Router::new()
        .route("/mobile", get(mobile_landing));

    // Combine all routes. The remote server does NOT expose the desktop
    // React SPA — `mobile_landing` is self-contained, and serving the full
    // desktop bundle over the tunnel would leak source code (Bug #14).
    // Root `/` and any unknown path redirect to `/mobile`.
    let app = Router::new()
        .merge(api_routes)
        .merge(proxy_routes)
        .merge(mobile)
        .route("/", get(redirect_to_mobile))
        .route("/LU-monogram-white.png", get(mobile_monogram))
        .fallback(redirect_to_mobile);

    app.layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .layer(cors)
        .with_state(state)
}

async fn redirect_to_mobile() -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, "/mobile")
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::FOUND.into_response())
}

/// Serve the LU monogram PNG embedded in the desktop public/ dir.
/// This is the only binary asset the mobile page needs — bundle it
/// at compile time so we never depend on `dist/` being present.
async fn mobile_monogram() -> Response {
    const MONOGRAM: &[u8] = include_bytes!("../../../public/LU-monogram-white.png");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(Body::from(MONOGRAM))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
