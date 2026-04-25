use std::fs;
use std::io::{BufRead, BufReader, Read as IoRead};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;

use crate::state::{AppState, InstallState};

/// Windows: hide console windows for spawned processes
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ── pip helpers (issue #32: PyTorch / ComfyUI install reliability) ───────────

/// Push a log line to the shared install state. Best-effort — silently
/// no-ops if the mutex is poisoned (which only happens if a thread panicked
/// while holding the lock; the install is already broken at that point).
fn push_install_log(state: &Arc<Mutex<InstallState>>, msg: &str) {
    if let Ok(mut s) = state.lock() {
        s.logs.push(msg.to_string());
    }
}

/// Detect pip errors that warrant an automatic retry with backoff.
/// Conservative — only retries on errors caused by transient network
/// conditions, not on auth, permission, disk-full, or python-side bugs.
fn is_transient_pip_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("403 ")
        || lower.contains("502 ")
        || lower.contains("503 ")
        || lower.contains("504 ")
        || lower.contains("429 ")
        || lower.contains("sslerror")
        || lower.contains("ssl: ")
        || lower.contains("readtimeouterror")
        || lower.contains("connecttimeouterror")
        || lower.contains("connectiontimeouterror")
        || lower.contains("connectionerror")
        || lower.contains("connectionreseterror")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("connection refused")
        || lower.contains("incompleteread")
        || lower.contains("temporary failure")
        || lower.contains("network is unreachable")
        || lower.contains("could not fetch")
        || lower.contains("read timed out")
        || lower.contains("eof occurred in violation of protocol")
        || lower.contains("max retries exceeded")
}

/// Turn raw pip stderr into a user-friendly hint with troubleshooting
/// guidance. The first line of the returned string is a short diagnosis;
/// the rest is the truncated original error for context.
fn diagnose_pip_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    let snippet: String = stderr.chars().take(400).collect();

    let hint = if lower.contains("ssl") {
        "SSL error reaching pypi.org. Often caused by an antivirus / firewall \
         intercepting TLS, or a stale system clock. Disable TLS interception \
         for python.exe, fix the system clock, then retry."
    } else if lower.contains("403 ") {
        "HTTP 403 from pypi.org or pytorch.org. The mirror may be blocked on \
         your network. Try a different network or VPN, then retry."
    } else if lower.contains("429 ") {
        "Rate limited (HTTP 429). Wait a few minutes and retry."
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "Network timeout. Slow connection or congested mirror. Retry on a \
         faster network, or run the install during off-peak hours."
    } else if lower.contains("connection") {
        "Connection error. Check internet connectivity, restart the app, \
         and retry."
    } else if lower.contains("no space") || lower.contains("errno 28") {
        "Out of disk space. PyTorch + dependencies need ~5 GB free. Free up \
         space and retry."
    } else if lower.contains("permission") || lower.contains("errno 13") {
        "Permission denied. Make sure no other process is using Python, then \
         retry. On Windows: close any open Python REPLs / Jupyter / IDE \
         debuggers."
    } else if lower.contains("no module named") || lower.contains("modulenotfounderror") {
        "Python install is missing pip or is broken. Reinstall Python 3.10+ \
         from python.org with 'Add to PATH' checked."
    } else if lower.contains("could not find a version") {
        "No matching wheel for your Python version. ComfyUI needs Python \
         3.10, 3.11, or 3.12. Reinstall a supported Python version."
    } else {
        ""
    };

    if hint.is_empty() {
        snippet
    } else {
        format!("{}\n\n--- pip output ---\n{}", hint, snippet)
    }
}

/// Run a `python -m pip install ...` command, streaming its stdout + stderr
/// line-by-line into the install state's `logs` so the user sees live
/// progress instead of a frozen UI. Retries up to `max_attempts` times on
/// transient network errors with exponential backoff (10s, 30s, 90s).
///
/// On non-transient errors or after exhausting retries, returns Err with a
/// human-readable diagnosis prepended to the truncated original error.
fn pip_install_streaming_with_retry(
    args: &[&str],
    python_bin: &str,
    max_attempts: u32,
    install_state: &Arc<Mutex<InstallState>>,
) -> Result<(), String> {
    let mut delay_seconds = 10u64;
    let mut last_stderr = String::new();

    for attempt in 1..=max_attempts {
        if attempt > 1 {
            push_install_log(
                install_state,
                &format!(
                    "Transient network error — retry {}/{} after {}s wait...",
                    attempt, max_attempts, delay_seconds
                ),
            );
            std::thread::sleep(std::time::Duration::from_secs(delay_seconds));
            delay_seconds = (delay_seconds * 3).min(180);
        }

        let mut cmd = Command::new(python_bin);
        cmd.args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(format!("Could not start pip ({}). Is Python on PATH?", e)),
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stderr_capture: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

        // Stream stdout to install logs
        let stdout_state = install_state.clone();
        let stdout_handle = std::thread::spawn(move || {
            if let Some(out) = stdout {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Ok(mut s) = stdout_state.lock() {
                            s.logs.push(trimmed.to_string());
                        }
                    }
                }
            }
        });

        // Stream stderr to install logs AND capture for retry decision
        let stderr_state = install_state.clone();
        let stderr_capture_clone = stderr_capture.clone();
        let stderr_handle = std::thread::spawn(move || {
            if let Some(err) = stderr {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(mut buf) = stderr_capture_clone.lock() {
                        buf.push_str(&line);
                        buf.push('\n');
                    }
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Ok(mut s) = stderr_state.lock() {
                            s.logs.push(trimmed.to_string());
                        }
                    }
                }
            }
        });

        let exit_status = match child.wait() {
            Ok(s) => s,
            Err(e) => return Err(format!("pip wait failed: {}", e)),
        };
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        if exit_status.success() {
            return Ok(());
        }

        last_stderr = stderr_capture
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();

        if !is_transient_pip_error(&last_stderr) {
            return Err(diagnose_pip_error(&last_stderr));
        }
    }

    Err(format!(
        "Exhausted {} retry attempts for transient network errors.\n\n{}",
        max_attempts,
        diagnose_pip_error(&last_stderr)
    ))
}

#[tauri::command]
pub fn install_comfyui(
    install_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut install = state.install_status.lock().unwrap();
    if install.status == "installing" {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "installing".to_string();
    install.logs.clear();
    install.logs.push("Starting ComfyUI installation...".to_string());
    drop(install);

    let target_dir = install_path
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("ComfyUI"));

    let python_bin = state.python_bin.clone();
    let install_status = state.install_status.clone();

    std::thread::spawn(move || {
        // Helper to update install status + logs
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_status.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Step 1: Git clone
        println!("[Install] Cloning ComfyUI to {:?}", target_dir);
        update("downloading", "Step 1/3: Downloading ComfyUI repository...");

        let mut cmd = Command::new("git");
        cmd.args(["clone", "https://github.com/comfyanonymous/ComfyUI.git"])
            .arg(&target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let clone = cmd.output();

        match clone {
            Ok(output) if output.status.success() => {
                println!("[Install] Git clone successful");
                update("installing", "Repository cloned successfully.");
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if stderr.contains("already exists") {
                    println!("[Install] ComfyUI directory already exists, updating...");
                    update("installing", "ComfyUI already exists, pulling latest...");
                    let mut pull = Command::new("git");
                    pull.args(["pull"]).current_dir(&target_dir)
                        .stdout(Stdio::piped()).stderr(Stdio::piped());
                    #[cfg(target_os = "windows")]
                    pull.creation_flags(CREATE_NO_WINDOW);
                    let _ = pull.output();
                } else {
                    let err = format!("Git clone failed: {}", stderr);
                    println!("[Install] {}", err);
                    update("error", &err);
                    return;
                }
            }
            Err(e) => {
                let err = format!("Git is not installed or not in PATH: {}", e);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        }

        // Step 2: Detect GPU and install PyTorch
        let mut nv = Command::new("nvidia-smi");
        nv.stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        nv.creation_flags(CREATE_NO_WINDOW);
        let has_nvidia = nv.output().map(|o| o.status.success()).unwrap_or(false);

        let gpu_info = if has_nvidia { "NVIDIA GPU detected — installing CUDA PyTorch" } else { "No NVIDIA GPU — installing CPU PyTorch" };
        println!("[Install] {}", gpu_info);
        update("installing", &format!("Step 2/3: {}", gpu_info));
        update(
            "installing",
            "Downloading PyTorch + Torchvision + Torchaudio (~2 GB total). \
             On a typical home connection this takes 10–15 minutes; on slower \
             links it can be longer. Live pip output below — if you see new \
             lines appearing, the install is making progress, not hung.",
        );

        let torch_args: Vec<&str> = if has_nvidia {
            vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "torch", "torchvision", "torchaudio",
                "--index-url", "https://download.pytorch.org/whl/cu121",
            ]
        } else {
            vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "torch", "torchvision", "torchaudio",
            ]
        };

        match pip_install_streaming_with_retry(&torch_args, &python_bin, 3, &install_status) {
            Ok(()) => {
                update("installing", "PyTorch installed successfully.");
            }
            Err(diagnosis) => {
                let err = format!("PyTorch installation failed.\n\n{}", diagnosis);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        }

        // Step 3: Install ComfyUI requirements
        println!("[Install] Installing ComfyUI requirements...");
        update("installing", "Step 3/3: Installing ComfyUI dependencies (live pip output below)...");

        let reqs = target_dir.join("requirements.txt");
        if reqs.exists() {
            let reqs_str = reqs.to_string_lossy().to_string();
            let req_args = vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "-r", reqs_str.as_str(),
            ];
            match pip_install_streaming_with_retry(&req_args, &python_bin, 3, &install_status) {
                Ok(()) => {
                    update("installing", "Dependencies installed successfully.");
                }
                Err(diagnosis) => {
                    // Don't fail the whole install — some optional deps may fail
                    // but ComfyUI can still start and the user can fix them later.
                    println!("[Install] Requirements install warning: {}", diagnosis);
                    update("installing", "Some optional dependencies had warnings (non-critical, ComfyUI should still start).");
                }
            }
        }

        println!("[Install] ComfyUI installation complete");
        update("complete", "ComfyUI installed successfully!");
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn install_comfyui_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.install_status.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

// ── Shared helper: download a file with progress tracking ────────────────────

fn download_file_blocking(
    url: &str,
    dest: &PathBuf,
    install_state: &Arc<Mutex<InstallState>>,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("LocallyUncensored/2.3")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client.get(url).send().map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    if let Ok(mut s) = install_state.lock() {
        s.download_total = total;
        s.status = "downloading".to_string();
    }

    let mut file = fs::File::create(dest).map_err(|e| format!("Create file: {}", e))?;
    let mut reader = std::io::BufReader::new(response);
    let mut downloaded: u64 = 0;
    let start = Instant::now();
    let mut last_update = Instant::now();
    let mut buf = [0u8; 65536]; // 64KB chunks

    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("Write: {}", e))?;
        downloaded += n as u64;

        if last_update.elapsed().as_millis() > 500 {
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            let speed = downloaded as f64 / elapsed;
            if let Ok(mut s) = install_state.lock() {
                s.download_progress = downloaded;
                s.download_speed = speed;
            }
            last_update = Instant::now();
        }
    }

    // Final update
    if let Ok(mut s) = install_state.lock() {
        s.download_progress = downloaded;
        s.download_total = downloaded; // in case Content-Length was missing
        s.download_speed = 0.0;
    }

    Ok(())
}

// ── Ollama Install ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn install_ollama(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut install = state.ollama_install.lock().unwrap();
    if install.status == "downloading" || install.status == "installing" || install.status == "starting" {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "downloading".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install.logs.push("Downloading Ollama installer...".to_string());
    drop(install);

    let ollama_state = state.ollama_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = ollama_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Step 1: Download OllamaSetup.exe
        let temp_dir = std::env::temp_dir();
        let installer_path = temp_dir.join("OllamaSetup.exe");

        println!("[Ollama] Downloading OllamaSetup.exe...");

        match download_file_blocking(
            "https://ollama.com/download/OllamaSetup.exe",
            &installer_path,
            &ollama_state,
        ) {
            Ok(()) => {
                println!("[Ollama] Download complete");
                update("installing", "Download complete. Installing Ollama...");
            }
            Err(e) => {
                let err = format!("Download failed: {}", e);
                println!("[Ollama] {}", err);
                update("error", &err);
                return;
            }
        }

        // Step 2: Run silent install
        println!("[Ollama] Running silent installer...");
        let mut cmd = Command::new(&installer_path);
        cmd.arg("/S");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        match cmd.output() {
            Ok(output) if output.status.success() => {
                println!("[Ollama] Installation successful");
                update("starting", "Ollama installed. Starting Ollama...");
            }
            Ok(output) => {
                let code = output.status.code().unwrap_or(-1);
                // NSIS installer returns 0 on success; non-zero might still be OK
                println!("[Ollama] Installer exited with code {}", code);
                update("starting", &format!("Installer finished (code {}). Starting Ollama...", code));
            }
            Err(e) => {
                let err = format!("Could not run installer: {}", e);
                println!("[Ollama] {}", err);
                update("error", &err);
                return;
            }
        }

        // Cleanup installer
        let _ = fs::remove_file(&installer_path);

        // Step 3: Start ollama serve
        println!("[Ollama] Starting ollama serve...");
        let mut serve = Command::new("ollama");
        serve.arg("serve").stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        serve.creation_flags(CREATE_NO_WINDOW);

        // Try to start — may already be running as service
        let _ = serve.spawn();

        // Step 4: Wait for Ollama to respond (up to 30 seconds)
        println!("[Ollama] Waiting for Ollama to be ready...");
        update("starting", "Waiting for Ollama to start...");

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap_or_default();

        let mut ready = false;
        for i in 0..15 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            match client.get("http://localhost:11434/api/tags").send() {
                Ok(res) if res.status().is_success() => {
                    ready = true;
                    break;
                }
                _ => {
                    println!("[Ollama] Not ready yet, attempt {}/15", i + 1);
                }
            }
        }

        if ready {
            println!("[Ollama] Ready!");
            update("complete", "Ollama is ready!");
        } else {
            update("error", "Ollama installed but not responding. Try restarting the app.");
        }
    });

    Ok(serde_json::json!({"status": "downloading"}))
}

#[tauri::command]
pub fn install_ollama_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.ollama_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

// ──────────────────────────────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub fn install_custom_node(
    state: State<'_, AppState>,
    repoUrl: String,
    nodeName: String,
) -> Result<serde_json::Value, String> {
    let repo_url = repoUrl;
    let node_name = nodeName;
    // Find ComfyUI path from state
    let comfy_path = {
        let path = state.comfy_path.lock().unwrap();
        path.clone()
    };

    let comfy_dir = match comfy_path {
        Some(p) => PathBuf::from(p),
        None => {
            // Try to find it
            match crate::commands::process::find_comfyui_path() {
                Some(p) => PathBuf::from(p),
                None => return Err("ComfyUI not found. Install ComfyUI first.".to_string()),
            }
        }
    };

    let custom_nodes_dir = comfy_dir.join("custom_nodes");
    let target_dir = custom_nodes_dir.join(&node_name);

    // Create custom_nodes dir if it doesn't exist
    if !custom_nodes_dir.exists() {
        fs::create_dir_all(&custom_nodes_dir)
            .map_err(|e| format!("Failed to create custom_nodes directory: {}", e))?;
    }

    if target_dir.exists() {
        // Already exists — git pull to update
        println!("[Install] Custom node {} already exists, updating...", node_name);
        let mut cmd = Command::new("git");
        cmd.args(["pull"]).current_dir(&target_dir)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output()
            .map_err(|e| format!("Git pull failed: {}", e))?;

        let status = if output.status.success() { "updated" } else { "update_failed" };
        Ok(serde_json::json!({
            "status": status,
            "path": target_dir.to_string_lossy(),
        }))
    } else {
        // Clone the repo
        println!("[Install] Cloning custom node {} from {}", node_name, repo_url);
        let mut cmd = Command::new("git");
        cmd.args(["clone", &repo_url]).arg(&target_dir)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output()
            .map_err(|e| format!("Git clone failed: {}", e))?;

        if output.status.success() {
            // Install requirements.txt if it exists
            let reqs = target_dir.join("requirements.txt");
            if reqs.exists() {
                let python_bin = state.python_bin.clone();
                println!("[Install] Installing requirements for {}...", node_name);
                let mut pip = Command::new(&python_bin);
                pip.args(["-m", "pip", "install", "-r"]).arg(&reqs)
                    .stdout(Stdio::piped()).stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                pip.creation_flags(CREATE_NO_WINDOW);
                let _ = pip.output();
            }

            Ok(serde_json::json!({
                "status": "installed",
                "path": target_dir.to_string_lossy(),
            }))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Failed to clone {}: {}", node_name, stderr))
        }
    }
}

// ── tests (issue #32: PyTorch / ComfyUI install reliability) ────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_transient_pip_error ────────────────────────────────────────────

    #[test]
    fn transient_detects_403() {
        assert!(is_transient_pip_error(
            "ERROR: HTTP error 403 while getting https://files.pythonhosted.org/packages/.../torch.whl"
        ));
    }

    #[test]
    fn transient_detects_502() {
        assert!(is_transient_pip_error(
            "WARNING: Retrying after connection broken by 'NewConnectionError: 502 Bad Gateway'"
        ));
    }

    #[test]
    fn transient_detects_503() {
        assert!(is_transient_pip_error(
            "HTTP 503 service unavailable from pypi"
        ));
    }

    #[test]
    fn transient_detects_429_rate_limit() {
        assert!(is_transient_pip_error(
            "ERROR: 429 Too Many Requests"
        ));
    }

    #[test]
    fn transient_detects_ssl_error() {
        assert!(is_transient_pip_error(
            "SSLError(SSLZeroReturnError(...)) caused TLS handshake failure"
        ));
    }

    #[test]
    fn transient_detects_read_timeout() {
        assert!(is_transient_pip_error(
            "ReadTimeoutError(HTTPSConnectionPool(host='pypi.org', port=443): Read timed out.)"
        ));
    }

    #[test]
    fn transient_detects_connect_timeout() {
        assert!(is_transient_pip_error(
            "ConnectTimeoutError reaching pypi.org"
        ));
    }

    #[test]
    fn transient_detects_connection_reset() {
        assert!(is_transient_pip_error(
            "ConnectionResetError(10054, 'An existing connection was forcibly closed by the remote host', None, 10054, None)"
        ));
    }

    #[test]
    fn transient_detects_connection_aborted() {
        assert!(is_transient_pip_error(
            "ConnectionError: ('Connection aborted.', RemoteDisconnected(...))"
        ));
    }

    #[test]
    fn transient_detects_connection_refused() {
        assert!(is_transient_pip_error(
            "ConnectionRefusedError: [Errno 111] Connection refused"
        ));
    }

    #[test]
    fn transient_detects_incomplete_read() {
        assert!(is_transient_pip_error(
            "IncompleteRead(0 bytes read, 1024 more expected)"
        ));
    }

    #[test]
    fn transient_detects_max_retries() {
        assert!(is_transient_pip_error(
            "Max retries exceeded with url: /packages/torch.whl"
        ));
    }

    #[test]
    fn transient_rejects_permission_error() {
        assert!(!is_transient_pip_error(
            "PermissionError: [Errno 13] Permission denied: 'C:\\\\Python\\\\Lib\\\\site-packages\\\\torch'"
        ));
    }

    #[test]
    fn transient_rejects_no_module_error() {
        assert!(!is_transient_pip_error(
            "ModuleNotFoundError: No module named 'pip'"
        ));
    }

    #[test]
    fn transient_rejects_disk_full() {
        assert!(!is_transient_pip_error(
            "OSError: [Errno 28] No space left on device"
        ));
    }

    #[test]
    fn transient_rejects_no_matching_distribution() {
        assert!(!is_transient_pip_error(
            "ERROR: Could not find a version that satisfies the requirement torch (from versions: none)"
        ));
    }

    #[test]
    fn transient_rejects_404_missing_package() {
        // 404 means the file genuinely doesn't exist — retry won't help.
        assert!(!is_transient_pip_error(
            "ERROR: HTTP error 404 while getting nonexistent-package.whl"
        ));
    }

    // ── diagnose_pip_error ────────────────────────────────────────────────

    #[test]
    fn diagnose_ssl_includes_antivirus_hint() {
        let msg = diagnose_pip_error("SSLError(SSLZeroReturnError(...))");
        let lower = msg.to_lowercase();
        assert!(lower.contains("antivirus") || lower.contains("firewall") || lower.contains("clock"));
    }

    #[test]
    fn diagnose_403_suggests_vpn() {
        let msg = diagnose_pip_error("HTTP 403 from pytorch.org");
        let lower = msg.to_lowercase();
        assert!(lower.contains("vpn") || lower.contains("network") || lower.contains("blocked"));
    }

    #[test]
    fn diagnose_429_mentions_rate_limit() {
        let msg = diagnose_pip_error("HTTP 429 Too Many Requests");
        assert!(msg.to_lowercase().contains("rate limit"));
    }

    #[test]
    fn diagnose_disk_full_mentions_space() {
        let msg = diagnose_pip_error("OSError: [Errno 28] No space left on device");
        assert!(msg.to_lowercase().contains("disk") || msg.to_lowercase().contains("space"));
    }

    #[test]
    fn diagnose_permission_suggests_close_python() {
        let msg = diagnose_pip_error("PermissionError: [Errno 13] Permission denied");
        let lower = msg.to_lowercase();
        assert!(lower.contains("permission") && (lower.contains("python") || lower.contains("close") || lower.contains("ide")));
    }

    #[test]
    fn diagnose_no_module_suggests_python_reinstall() {
        let msg = diagnose_pip_error("ModuleNotFoundError: No module named 'pip'");
        let lower = msg.to_lowercase();
        assert!(lower.contains("python") && (lower.contains("reinstall") || lower.contains("3.10")));
    }

    #[test]
    fn diagnose_no_matching_version_suggests_python_version() {
        let msg = diagnose_pip_error("ERROR: Could not find a version that satisfies the requirement torch");
        let lower = msg.to_lowercase();
        assert!(lower.contains("python") || lower.contains("version") || lower.contains("3.10"));
    }

    #[test]
    fn diagnose_unknown_error_falls_through_to_snippet() {
        let raw = "some_completely_random_error_we_haven_t_categorized";
        let msg = diagnose_pip_error(raw);
        assert!(msg.contains(raw));
    }

    #[test]
    fn diagnose_truncates_giant_stderr_to_400_chars_snippet_block() {
        let huge: String = "x".repeat(2000);
        let raw = format!("SSLError: {}", huge);
        let msg = diagnose_pip_error(&raw);
        // Snippet portion is bounded to 400 chars; full message includes hint + label
        // so it should be much shorter than the raw 2000-char input.
        assert!(msg.len() < 1200, "diagnose output was {} chars", msg.len());
    }

    // ── push_install_log ──────────────────────────────────────────────────

    #[test]
    fn push_install_log_appends_to_logs() {
        let state = Arc::new(Mutex::new(InstallState::default()));
        push_install_log(&state, "first");
        push_install_log(&state, "second");
        let s = state.lock().unwrap();
        assert_eq!(s.logs, vec!["first", "second"]);
    }

    #[test]
    fn push_install_log_does_not_clobber_status() {
        let state = Arc::new(Mutex::new(InstallState::default()));
        {
            let mut s = state.lock().unwrap();
            s.status = "installing".to_string();
        }
        push_install_log(&state, "log line");
        let s = state.lock().unwrap();
        assert_eq!(s.status, "installing");
        assert_eq!(s.logs, vec!["log line"]);
    }
}
