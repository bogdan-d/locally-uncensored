// OAuth loopback listener for the LU Cloud login (Google/GitHub via the
// system browser). No deep links: the frontend binds a 127.0.0.1 port from a
// fixed ladder (registered in the Supabase redirect allow-list), opens the
// provider URL in the system browser, and Supabase redirects back to
// http://127.0.0.1:<port>/callback?code=… — this module catches that single
// request and hands the query string to the frontend, which exchanges the
// PKCE code for a session. The code alone is useless without the PKCE
// verifier held app-side, so a local port-sniffing race gains nothing.

use std::collections::HashMap;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

// Fixed port ladder — Supabase's uri_allow_list has no port wildcards, so
// these three exact URIs are registered. Three tries ride out a collision
// with another app or a lingering listener.
const PORT_LADDER: [u16; 3] = [17872, 17873, 17874];

#[derive(Default)]
pub struct OauthPending(pub Mutex<HashMap<u16, oneshot::Receiver<String>>>);

const CALLBACK_BODY: &str = "<!doctype html><html><body style=\"font-family:-apple-system,system-ui,sans-serif;background:#161616;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><p>Signed in — you can close this tab and return to LU.</p></body></html>";

/// Bind the first free ladder port and arm a single-shot accept. Returns the
/// port so the frontend can build the redirect URI before opening the browser.
#[tauri::command]
pub async fn oauth_start(state: tauri::State<'_, OauthPending>) -> Result<u16, String> {
    for port in PORT_LADDER {
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(_) => continue, // port taken — try the next rung
        };
        let (tx, rx) = oneshot::channel::<String>();
        state.0.lock().unwrap().insert(port, rx);
        tauri::async_runtime::spawn(async move {
            // One request only; the listener drops with this task. If oauth_wait
            // times out first, tx.send just errs into the void — harmless.
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            // Request line: GET /callback?code=…&state=… HTTP/1.1
            let query = req
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|path| path.split_once('?').map(|(_, q)| q.to_string()))
                .unwrap_or_default();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                CALLBACK_BODY.len(),
                CALLBACK_BODY
            );
            let _ = stream.write_all(resp.as_bytes()).await;
            let _ = stream.shutdown().await;
            let _ = tx.send(query);
        });
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
    let rx = state
        .0
        .lock()
        .unwrap()
        .remove(&port)
        .ok_or("no pending oauth listener on that port")?;
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs.clamp(10, 900)), rx).await {
        Ok(Ok(query)) => Ok(query),
        Ok(Err(_)) => Err("oauth listener closed before the browser returned".into()),
        Err(_) => Err("sign-in timed out — the browser never came back".into()),
    }
}
