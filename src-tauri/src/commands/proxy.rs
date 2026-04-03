/// Validate that an external URL is safe to fetch (no SSRF).
/// Blocks private IP ranges, non-HTTP schemes, and localhost.
fn validate_external_url(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| format!("Invalid URL: {}", e))?;

    // Only allow http and https
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Blocked scheme: {}", other)),
    }

    let host = parsed.host_str().unwrap_or("");

    // Block localhost variants
    if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        || host == "0.0.0.0" || host.ends_with(".localhost")
    {
        return Err("Blocked: localhost access not allowed for external fetch".into());
    }

    // Block private/reserved IPv4 ranges
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        let octets = ip.octets();
        let blocked = matches!(octets,
            [10, ..] |                                          // 10.0.0.0/8
            [172, 16..=31, ..] |                                // 172.16.0.0/12
            [192, 168, ..] |                                    // 192.168.0.0/16
            [127, ..] |                                         // 127.0.0.0/8
            [169, 254, ..] |                                    // 169.254.0.0/16 (link-local)
            [0, ..]                                             // 0.0.0.0/8
        );
        if blocked {
            return Err(format!("Blocked: private/reserved IP {}", ip));
        }
    }

    // Block private IPv6 (fc00::/7, fe80::/10, ::1)
    if let Ok(ip) = host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::Ipv6Addr>() {
        let segments = ip.segments();
        let blocked = ip.is_loopback()
            || (segments[0] & 0xfe00) == 0xfc00   // fc00::/7 (unique local)
            || (segments[0] & 0xffc0) == 0xfe80;  // fe80::/10 (link-local)
        if blocked {
            return Err(format!("Blocked: private/reserved IPv6 {}", ip));
        }
    }

    Ok(())
}

/// Generic HTTP proxy — fetch any external URL and return body as string.
/// Used for CivitAI API calls, workflow JSON downloads, etc.
#[tauri::command]
pub async fn fetch_external(url: String) -> Result<String, String> {
    validate_external_url(&url)?;

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch_external: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), url));
    }

    resp.text().await.map_err(|e| e.to_string())
}

/// Binary HTTP proxy — fetch any external URL and return bytes.
/// Used for downloading ZIP files, images, model files.
#[tauri::command]
pub async fn fetch_external_bytes(url: String) -> Result<Vec<u8>, String> {
    validate_external_url(&url)?;

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch_external_bytes: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), url));
    }

    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// Generic localhost proxy — fetch any localhost URL bypassing CORS.
/// Used for Ollama and ComfyUI API calls in production mode.
#[tauri::command]
pub async fn proxy_localhost(url: String, method: Option<String>, body: Option<String>) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    if let Some(body_str) = body {
        request = request.header("Content-Type", "application/json").body(body_str);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| format!("proxy_localhost: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    resp.text().await.map_err(|e| e.to_string())
}

/// Streaming localhost proxy — returns raw bytes for streaming responses (Ollama pull/chat).
#[tauri::command]
pub async fn proxy_localhost_stream(url: String, method: Option<String>, body: Option<String>) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| e.to_string())?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    if let Some(body_str) = body {
        request = request.header("Content-Type", "application/json").body(body_str);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| format!("proxy_localhost_stream: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// Proxy search requests to ollama.com (needed because frontend can't CORS to ollama.com)
#[tauri::command]
pub async fn ollama_search(query: String) -> Result<serde_json::Value, String> {
    let url = format!(
        "https://ollama.com/search?q={}&p=1",
        urlencoding::encode(&query)
    );

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Ollama search: {}", e))?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Try to parse as JSON; if it's HTML, return empty results
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(json) => Ok(json),
        Err(_) => Ok(serde_json::json!({"models": []})),
    }
}
