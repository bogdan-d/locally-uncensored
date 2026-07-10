// OAuth loopback listener for the LU Cloud login (Google/GitHub via the
// system browser). No deep links: the frontend binds a 127.0.0.1 port from a
// fixed ladder (registered in the Supabase redirect allow-list), opens the
// provider URL in the system browser, and Supabase redirects back to
// http://127.0.0.1:<port>/callback?code=… — this module catches that single
// request and hands the query string to the frontend, which exchanges the
// PKCE code for a session. The code alone is useless without the PKCE
// verifier held app-side, so a local port-sniffing race gains nothing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

// Fixed port ladder — Supabase's uri_allow_list has no port wildcards, so
// these three exact URIs are registered. Three tries ride out a collision
// with another app or a lingering listener.
const PORT_LADDER: [u16; 3] = [17872, 17873, 17874];

// One armed attempt per port: the oneshot receiver oauth_wait consumes plus
// the accept task's handle. Aborting the task drops the bound TcpListener,
// which is the only way to free the port of an abandoned attempt (dropping
// the receiver alone never wakes a task parked in accept()). The id keeps a
// stale oauth_wait from tearing down a retry that re-armed the same port.
static NEXT_ATTEMPT: AtomicU64 = AtomicU64::new(0);

pub struct PendingLogin {
    id: u64,
    rx: Option<oneshot::Receiver<String>>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct OauthPending(pub Mutex<HashMap<u16, PendingLogin>>);

const CALLBACK_BODY: &str = "<!doctype html><html><body style=\"font-family:-apple-system,system-ui,sans-serif;background:#161616;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><p>Signed in — you can close this tab and return to LU.</p></body></html>";
const DENIED_BODY: &str = "<!doctype html><html><body style=\"font-family:-apple-system,system-ui,sans-serif;background:#161616;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><p>Sign-in didn't complete — you can close this tab and try again in LU.</p></body></html>";

/// Bind the first free ladder port and arm an accept loop that serves exactly
/// one callback (strays get a 404). Returns the port so the frontend can build
/// the redirect URI before opening the browser.
#[tauri::command]
pub async fn oauth_start(state: tauri::State<'_, OauthPending>) -> Result<u16, String> {
    // Only one sign-in flow at a time: abort every stale attempt first so an
    // abandoned one (closed browser tab, cancelled wait) releases its ladder
    // port instead of leaking the listener for the process lifetime.
    let stale: Vec<PendingLogin> = state.0.lock().unwrap().drain().map(|(_, p)| p).collect();
    for pending in stale {
        pending.task.abort();
        // Wait for the abort to land so the port is actually free to rebind.
        let _ = pending.task.await;
    }
    for port in PORT_LADDER {
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(_) => continue, // port taken — try the next rung
        };
        let (tx, rx) = oneshot::channel::<String>();
        let task = tauri::async_runtime::spawn(async move {
            // Accept until a request actually carries the callback query
            // (code=… or error=…). Strays — browser preconnects that send no
            // bytes, favicon fetches, localhost port probes — get a 404 and
            // the armed window stays open for the real redirect. oauth_wait's
            // timeout/abort bounds the loop's lifetime; the listener drops
            // with this task. If oauth_wait times out first, tx.send just
            // errs into the void — harmless.
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let mut buf = vec![0u8; 8192];
                // Short read deadline so an idle preconnect socket can't park
                // the loop while the real callback waits in the backlog.
                let n = match tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    stream.read(&mut buf),
                )
                .await
                {
                    Ok(Ok(n)) => n,
                    _ => 0,
                };
                let req = String::from_utf8_lossy(&buf[..n]);
                // Request line: GET /callback?code=…&state=… HTTP/1.1
                let query = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|path| path.split_once('?').map(|(_, q)| q.to_string()))
                    .unwrap_or_default();
                let is_callback = query
                    .split('&')
                    .any(|kv| kv.starts_with("code=") || kv.starts_with("error="));
                if !is_callback {
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                    let _ = stream.shutdown().await;
                    continue;
                }
                // Provider denial arrives as error=…&error_description=… — be
                // honest in the tab; the frontend gets the raw query either way.
                let body = if query.split('&').any(|kv| kv.starts_with("error=")) {
                    DENIED_BODY
                } else {
                    CALLBACK_BODY
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
                let _ = stream.shutdown().await;
                let _ = tx.send(query);
                return;
            }
        });
        let id = NEXT_ATTEMPT.fetch_add(1, Ordering::Relaxed);
        state
            .0
            .lock()
            .unwrap()
            .insert(port, PendingLogin { id, rx: Some(rx), task });
        return Ok(port);
    }
    Err("no loopback port available (17872-17874) — close the app using them and retry".into())
}

/// Await the browser round-trip on a port armed by oauth_start. Returns the
/// raw callback query string (code=…, or error=…&error_description=…).
#[tauri::command]
pub async fn oauth_wait(
    port: u16,
    timeout_secs: u64,
    state: tauri::State<'_, OauthPending>,
) -> Result<String, String> {
    // Take the receiver but leave the entry, so a concurrent oauth_start
    // (retry after a UI cancel) can still find and abort the accept task.
    let (id, rx) = {
        let mut map = state.0.lock().unwrap();
        let pending = map
            .get_mut(&port)
            .ok_or("no pending oauth listener on that port")?;
        let rx = pending
            .rx
            .take()
            .ok_or("oauth wait already running on that port")?;
        (pending.id, rx)
    };
    let result =
        tokio::time::timeout(std::time::Duration::from_secs(timeout_secs.clamp(10, 900)), rx).await;
    // The attempt is over either way — drop the accept task so the listener
    // releases the port (no-op if it already served the callback). Only touch
    // our own attempt: a retry's oauth_start may have drained it and re-armed
    // the same port already.
    {
        let mut map = state.0.lock().unwrap();
        if map.get(&port).is_some_and(|p| p.id == id) {
            if let Some(pending) = map.remove(&port) {
                pending.task.abort();
            }
        }
    }
    match result {
        Ok(Ok(query)) => Ok(query),
        Ok(Err(_)) => Err("oauth listener closed before the browser returned".into()),
        Err(_) => Err("sign-in timed out — the browser never came back".into()),
    }
}
