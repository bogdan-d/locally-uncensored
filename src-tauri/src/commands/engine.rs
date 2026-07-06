// P1 — Built-in inference engine (bundled llama.cpp `llama-server`).
//
// The whole point of 2.5.7's "onboarding without external providers" is that
// the app ships its own inference engine and never *requires* Ollama / LM
// Studio again. `llama-server` speaks an OpenAI-compatible API, so the
// existing `OpenAIProvider` + `proxy_localhost_stream_chunked` path drives it
// unchanged — this module owns only the *lifecycle* (spawn / health-wait /
// stop / model-swap) of the sidecar process, mirroring `start_ollama`.
//
// One model per process: `llama-server` loads a single GGUF, so a model swap
// is a stop→start with a new `-m` (Ollama-like, ~1-3 s). The child handle
// lives in `AppState.bundled_engine` and is killed in `shutdown_subprocesses`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::state::{AppState, BundledEngine};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Default loopback port for the managed chat engine. Matches the `builtin`
/// preset base URL on the frontend (`http://127.0.0.1:8127/v1`).
pub const DEFAULT_ENGINE_PORT: u16 = 8127;

/// How long to wait for `/health` to flip to 200 after spawn. A cold GGUF
/// load (mmap + Metal warm-up) on a big model can take a while on a slow disk;
/// 60 s is comfortably above a normal 1-3 s load without hanging forever on a
/// binary that never comes up.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);

// ── Pure helpers (unit-tested without a real binary) ─────────────────────────

/// Sidecar file name Tauri produces from `externalBin: ["bin/llama-server"]`
/// inside the bundled app (target-triple suffix stripped, `.exe` on Windows).
pub(crate) fn sidecar_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// Rust host target-triple, used to locate the dev-time sidecar produced by
/// `scripts/build-llama.sh` (`bin/llama-server-<triple>[.exe]`). mac-first for
/// 2.5.7; win/linux triples are here so P6 doesn't need to touch this.
pub(crate) fn host_target_triple() -> String {
    let arch = std::env::consts::ARCH; // "aarch64" | "x86_64" | ...
    match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        _ => format!("{arch}-unknown-linux-gnu"),
    }
}

/// Build the `llama-server` argv for a chat engine. `-ngl 999` offloads every
/// layer to the GPU (Metal on mac); llama-server clamps to the real layer
/// count, so an over-large value is the idiomatic "all layers" request.
pub(crate) fn build_server_args(model_path: &str, ctx: u32, port: u16) -> Vec<String> {
    vec![
        "-m".into(),
        model_path.into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--ctx-size".into(),
        ctx.to_string(),
        "-ngl".into(),
        "999".into(),
    ]
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct BundledModel {
    /// File name without the `.gguf` extension — the id the frontend shows and
    /// passes back to `swap_bundled_model`.
    pub name: String,
    /// Absolute path to the GGUF file.
    pub path: String,
    /// File size in bytes (0 if it couldn't be stat-ed).
    pub size: u64,
}

/// Scan a directory (non-recursive) for `*.gguf` files. Case-insensitive on
/// the extension so `Model.GGUF` from a manual copy still shows up. Sorted by
/// name for a stable UI ordering. Missing dir → empty list (not an error): a
/// fresh install has no models yet.
pub(crate) fn scan_gguf_models(dir: &Path) -> Vec<BundledModel> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_gguf = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false);
        if !is_gguf {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(BundledModel {
            name,
            path: path.to_string_lossy().to_string(),
            size,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// App-owned models directory for the built-in engine:
/// `{data_dir}/Locally Uncensored/models`. Created on demand so the first
/// download / scan just works on a fresh box. This is the same path
/// `detect_model_path("builtin")` returns.
pub fn builtin_models_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("Cannot resolve app data directory")?;
    let dir = base.join("Locally Uncensored").join("models");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Create built-in models dir: {e}"))?;
    Ok(dir)
}

// ── Sidecar resolution ───────────────────────────────────────────────────────

/// Locate the bundled `llama-server` binary. Prod: next to the main
/// executable (where Tauri copies `externalBin`). Dev: the target-triple
/// artifact `scripts/build-llama.sh` drops into `src-tauri/bin/`.
fn resolve_engine_binary(app: &AppHandle) -> Option<PathBuf> {
    // 1. Bundled: same dir as the running app binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(sidecar_binary_name());
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 2. Resource dir (belt-and-suspenders for platforms that stage it there).
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join(sidecar_binary_name());
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // 3. Dev: src-tauri/bin/llama-server-<triple>[.exe]. `tauri dev` runs the
    //    binary from target/debug, so walk up to the manifest dir.
    let triple = host_target_triple();
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let dev_name = format!("llama-server-{triple}{suffix}");
    let mut dev_candidates: Vec<PathBuf> = Vec::new();
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        dev_candidates.push(PathBuf::from(&manifest).join("bin").join(&dev_name));
    }
    if let Ok(cwd) = std::env::current_dir() {
        dev_candidates.push(cwd.join("src-tauri").join("bin").join(&dev_name));
        dev_candidates.push(cwd.join("bin").join(&dev_name));
    }
    dev_candidates.into_iter().find(|p| p.exists())
}

// ── Health probe ─────────────────────────────────────────────────────────────

fn engine_healthy(port: u16) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
        .ok()
        .and_then(|c| c.get(format!("http://127.0.0.1:{port}/health")).send().ok())
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Block until `/health` returns 200 or `HEALTH_TIMEOUT` elapses. Returns
/// `Ok(())` on ready, `Err` with a hint on timeout so the UI can surface a
/// real message instead of a silent hang.
fn wait_for_health(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    while Instant::now() < deadline {
        if engine_healthy(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(format!(
        "Built-in engine did not become healthy on port {port} within {}s",
        HEALTH_TIMEOUT.as_secs()
    ))
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Start (or reuse) the managed chat engine for `model_path`. Idempotent: if
/// the same model is already loaded and healthy, returns `already_running`.
/// A different model in flight is stopped first (single-process engine).
#[tauri::command]
pub fn start_bundled_engine(
    app: AppHandle,
    state: State<'_, AppState>,
    model_path: String,
    ctx: Option<u32>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let ctx = ctx.unwrap_or(8192);
    let port = port.unwrap_or(DEFAULT_ENGINE_PORT);

    if !Path::new(&model_path).exists() {
        return Err(format!("Model file not found: {model_path}"));
    }

    // Already serving this exact model and healthy → no-op.
    {
        let guard = state.bundled_engine.lock().unwrap();
        if let Some(engine) = guard.as_ref() {
            if engine.model_path == model_path && engine_healthy(engine.port) {
                return Ok(serde_json::json!({
                    "status": "already_running",
                    "port": engine.port,
                    "model_path": engine.model_path,
                }));
            }
        }
    }

    // Different model (or dead) → stop the old process before spawning.
    stop_engine_locked(&state);

    let binary = resolve_engine_binary(&app).ok_or_else(|| {
        format!(
            "Bundled engine binary not found ({}). Run scripts/build-llama.sh to produce the sidecar.",
            sidecar_binary_name()
        )
    })?;

    println!("[Engine] Starting built-in llama-server on port {port} — {model_path}");
    let mut cmd = Command::new(&binary);
    cmd.args(build_server_args(&model_path, ctx, port))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Forward the user's GPU pick (CUDA/HIP/OneAPI) exactly like start_ollama;
    // no-op in the default "auto" mode. On mac this is inert (Metal).
    if let Ok(sel) = state.gpu_selection.lock() {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn bundled engine: {e}"))?;

    *state.bundled_engine.lock().unwrap() = Some(BundledEngine {
        child,
        model_path: model_path.clone(),
        port,
    });

    // Wait for the model to load. On failure, reap the child so we don't leave
    // a zombie half-loaded server behind.
    if let Err(e) = wait_for_health(port) {
        stop_engine_locked(&state);
        return Err(e);
    }

    println!("[Engine] Built-in engine healthy on port {port}");
    Ok(serde_json::json!({
        "status": "started",
        "port": port,
        "model_path": model_path,
    }))
}

/// Stop the managed engine, killing the child. Idempotent.
#[tauri::command]
pub fn stop_bundled_engine(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let was_running = stop_engine_locked(&state);
    Ok(serde_json::json!({ "status": if was_running { "stopped" } else { "idle" } }))
}

/// Report whether the engine is up, which model, on which port, and a live
/// health probe. `running` reflects the child handle; `healthy` the HTTP probe
/// (they diverge briefly during cold load).
#[tauri::command]
pub fn bundled_engine_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let guard = state.bundled_engine.lock().unwrap();
    match guard.as_ref() {
        Some(engine) => Ok(serde_json::json!({
            "running": true,
            "healthy": engine_healthy(engine.port),
            "port": engine.port,
            "model_path": engine.model_path,
        })),
        None => Ok(serde_json::json!({
            "running": false,
            "healthy": false,
            "port": DEFAULT_ENGINE_PORT,
            "model_path": null,
        })),
    }
}

/// Swap the loaded model: stop the current process and start `model_path` on
/// the same port. Thin wrapper over `start_bundled_engine` (which already
/// stops a mismatched model), kept as a distinct command so the intent reads
/// clearly at the call site and the port is preserved.
#[tauri::command]
pub fn swap_bundled_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model_path: String,
    ctx: Option<u32>,
) -> Result<serde_json::Value, String> {
    let port = state
        .bundled_engine
        .lock()
        .unwrap()
        .as_ref()
        .map(|e| e.port)
        .unwrap_or(DEFAULT_ENGINE_PORT);
    start_bundled_engine(app, state, model_path, ctx, Some(port))
}

/// List `*.gguf` files in the built-in models dir, marking the one currently
/// loaded. Used by the frontend instead of `/v1/models` (which would only
/// report the single loaded model).
#[tauri::command]
pub fn list_bundled_models(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let dir = builtin_models_dir()?;
    let loaded = state
        .bundled_engine
        .lock()
        .unwrap()
        .as_ref()
        .map(|e| e.model_path.clone());
    let models: Vec<serde_json::Value> = scan_gguf_models(&dir)
        .into_iter()
        .map(|m| {
            let is_loaded = loaded.as_deref() == Some(m.path.as_str());
            serde_json::json!({
                "name": m.name,
                "path": m.path,
                "size": m.size,
                "loaded": is_loaded,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "dir": dir.to_string_lossy(),
        "models": models,
    }))
}

/// Kill the managed engine child if present. Returns whether one was running.
/// Takes the state lock internally; callers must not already hold it.
fn stop_engine_locked(state: &State<'_, AppState>) -> bool {
    let mut guard = state.bundled_engine.lock().unwrap();
    if let Some(mut engine) = guard.take() {
        let _ = engine.child.kill();
        let _ = engine.child.wait();
        println!("[Engine] Built-in engine stopped (port {})", engine.port);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_include_model_ctx_port_and_full_gpu_offload() {
        let args = build_server_args("/models/qwen.gguf", 8192, 8127);
        assert_eq!(
            args,
            vec![
                "-m", "/models/qwen.gguf",
                "--host", "127.0.0.1",
                "--port", "8127",
                "--ctx-size", "8192",
                "-ngl", "999",
            ]
        );
    }

    #[test]
    fn host_triple_is_platform_shaped() {
        let t = host_target_triple();
        if cfg!(target_os = "macos") {
            assert!(t.ends_with("-apple-darwin"), "got {t}");
        } else if cfg!(target_os = "windows") {
            assert!(t.ends_with("-pc-windows-msvc"), "got {t}");
        } else {
            assert!(t.ends_with("-unknown-linux-gnu"), "got {t}");
        }
    }

    #[test]
    fn sidecar_name_has_exe_only_on_windows() {
        let name = sidecar_binary_name();
        if cfg!(target_os = "windows") {
            assert_eq!(name, "llama-server.exe");
        } else {
            assert_eq!(name, "llama-server");
        }
    }

    #[test]
    fn scan_finds_gguf_marks_none_loaded_and_ignores_others() {
        let dir = std::env::temp_dir().join(format!("lu-engine-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("alpha.gguf"), b"x").unwrap();
        std::fs::write(dir.join("Beta.GGUF"), b"yy").unwrap();
        std::fs::write(dir.join("notes.txt"), b"zzz").unwrap();
        std::fs::write(dir.join("model.bin"), b"w").unwrap();

        let models = scan_gguf_models(&dir);
        let names: Vec<&str> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Beta", "alpha"]); // sorted, case-insensitive ext
        assert_eq!(models[1].size, 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_missing_dir_is_empty_not_error() {
        let dir = std::env::temp_dir().join("lu-engine-nonexistent-xyz-123");
        assert!(scan_gguf_models(&dir).is_empty());
    }
}
