// WebSocket proxy for the ComfyUI progress stream (2.5.8, GH #75 family).
//
// ComfyUI 0.19+ ships an origin-check middleware (upstream commit 76b75f3)
// that 403s every cross-site request — including the WebView's
// `ws://host:port/ws` upgrade from `http://tauri.localhost`, which killed the
// live progress bar unless the user passed `--enable-cors-header`. HTTP
// already goes through the Rust localhost proxy (no browser Origin header →
// passes); this gives the progress WebSocket the same treatment: the frontend
// asks Rust to open the socket, Rust connects with a plain client handshake
// (tokio-tungstenite sends no Origin) and relays every text frame to the
// WebView as a `comfy-ws-message` Tauri event.
//
// Receive-only by design: the frontend never sends application frames on this
// socket (see src/api/comfyui-ws.ts), so no send command is exposed. Binary
// frames (live preview images) are skipped — the old direct-WS path dropped
// them too (JSON.parse on a Blob throws → ignored). Host + port come from
// AppState (same user-validated values the HTTP proxy allow-lists), never
// from the frontend, so this opens no new SSRF surface.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter, State};
use tokio_tungstenite::tungstenite::Message;

use crate::state::AppState;

struct ConnHandle {
    generation: u64,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// Single managed upstream connection — mirrors the frontend singleton
/// (`comfyWS` / one CLIENT_ID per app run). A new connect replaces the old
/// socket; generations keep a superseded reader from clobbering its
/// replacement's registration or emitting a stale close event.
static CONN: Lazy<tokio::sync::Mutex<Option<ConnHandle>>> =
    Lazy::new(|| tokio::sync::Mutex::new(None));
static NEXT_GEN: AtomicU64 = AtomicU64::new(1);

/// Open (or replace) the proxied ComfyUI progress socket. Resolves once the
/// upstream handshake succeeded — the frontend treats resolution like
/// `ws.onopen` and rejection like `ws.onerror` (falls back to /history
/// polling), so this must always settle; the timeout guarantees that.
#[tauri::command]
pub async fn comfy_ws_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: String,
) -> Result<(), String> {
    // Read the user-configured target before any await — these are std
    // Mutexes and must not be held across suspension points.
    let (host, port) = {
        let host = state.comfy_host.lock().unwrap().clone();
        let port = *state.comfy_port.lock().unwrap();
        (host, port)
    };
    let url = format!(
        "ws://{}:{}/ws?clientId={}",
        host,
        port,
        urlencoding::encode(&client_id)
    );

    let (stream, _resp) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(&url),
    )
    .await
    .map_err(|_| "ComfyUI WebSocket connect timeout".to_string())?
    .map_err(|e| format!("ComfyUI WebSocket connect failed: {}", e))?;

    let generation = NEXT_GEN.fetch_add(1, Ordering::Relaxed);

    // Hold the registry lock across spawn+insert so the reader's shutdown
    // path (which also takes this lock) can never observe a half-registered
    // connection, even if the socket dies instantly.
    let mut guard = CONN.lock().await;
    if let Some(old) = guard.take() {
        old.task.abort();
    }

    let task = tauri::async_runtime::spawn(async move {
        // The unsplit stream auto-handles ping/pong on poll; we never write.
        let mut stream = stream;
        loop {
            match stream.next().await {
                Some(Ok(Message::Text(text))) => {
                    let _ = app.emit("comfy-ws-message", text.as_str());
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                // Binary previews, ping/pong, raw frames: intentionally dropped.
                Some(Ok(_)) => {}
            }
        }
        // Announce the close only if this reader is still the live one —
        // a replaced/aborted reader must stay silent so it can't trigger a
        // spurious frontend reconnect against the connection that replaced it.
        let mut guard = CONN.lock().await;
        if guard.as_ref().map(|c| c.generation) == Some(generation) {
            *guard = None;
            let _ = app.emit("comfy-ws-closed", ());
        }
    });

    *guard = Some(ConnHandle { generation, task });
    Ok(())
}

/// Tear down the proxied socket, if any. Deliberately emits no close event:
/// the frontend only calls this from its own `disconnect()`, which already
/// resets its state (mirrors the old `ws.onclose = null; ws.close()`).
#[tauri::command]
pub async fn comfy_ws_disconnect() -> Result<(), String> {
    let mut guard = CONN.lock().await;
    if let Some(old) = guard.take() {
        old.task.abort();
    }
    Ok(())
}
