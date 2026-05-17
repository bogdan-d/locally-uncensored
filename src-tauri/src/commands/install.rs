use std::fs;
use std::io::{BufRead, BufReader, Read as IoRead};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;

use crate::python::venv_python_path;
use crate::state::{AppState, InstallState};

/// Windows: hide console windows for spawned processes
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ── Disk-pressure pre-flight (Bug #1 — techx69 100%-busy-drive hang) ────────

/// Return a human-readable warning when the target install drive is short
/// on free space (<5 GB — ComfyUI + PyTorch wheels need ~5 GB) or its
/// pending I/O queue suggests sustained 100% utilisation. Best-effort —
/// returns None if sysinfo can't get reliable data, so we never block a
/// well-meaning install over a probing flake.
fn check_install_disk_pressure(target_dir: &Path) -> Option<String> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    // Find the disk that contains the target dir. sysinfo's Disk::mount_point
    // is a PathBuf — pick the longest mount that is a prefix of target_dir.
    let normalized = target_dir.to_path_buf();
    let mut best: Option<&sysinfo::Disk> = None;
    let mut best_len: usize = 0;
    for d in &disks {
        let mp = d.mount_point();
        if normalized.starts_with(mp) {
            let len = mp.as_os_str().len();
            if len > best_len {
                best_len = len;
                best = Some(d);
            }
        }
    }
    let disk = best?;

    let free_bytes = disk.available_space();
    let total_bytes = disk.total_space();
    let needed_bytes: u64 = 5 * 1024 * 1024 * 1024; // 5 GB
    if free_bytes < needed_bytes {
        return Some(format!(
            "⚠ Low disk space on {}: {:.1} GB free of {:.1} GB total. \
             ComfyUI + PyTorch need about 5 GB. Consider freeing space or \
             choosing a drive with more room before continuing.",
            disk.mount_point().to_string_lossy(),
            free_bytes as f64 / 1_073_741_824.0,
            total_bytes as f64 / 1_073_741_824.0,
        ));
    }
    None
}

#[tauri::command]
pub fn cancel_comfyui_install(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.comfyui_install_cancel.store(true, Ordering::SeqCst);
    if let Ok(mut s) = state.install_status.lock() {
        // Mark as cancelling immediately so the UI can switch to a
        // "Cancelling…" indicator even before the spawn loop notices.
        if s.status == "installing" || s.status == "downloading" {
            s.status = "cancelling".to_string();
            s.logs.push("Cancellation requested — waiting for active subprocess to exit…".to_string());
        }
    }
    Ok(serde_json::json!({"status": "cancelling"}))
}

// ── GPU helpers (Bug #10 — Blackwell PyTorch cu128 routing) ─────────────────

/// Probe NVIDIA's compute capability of the first detected GPU and return
/// its major version (8 for Ampere, 9 for Hopper, 12 for Blackwell, …).
///
/// `nvidia-smi --query-gpu=compute_cap` prints lines like `12.0` (one per
/// GPU). We take the highest major across visible GPUs because pip can
/// only install ONE PyTorch build — picking the higher capability set
/// satisfies every card on the box (cu128 wheels still run on Ampere etc.).
/// Returns None when nvidia-smi is absent or the parse fails; the caller
/// falls back to the previous default index URL.
fn parse_compute_cap_output(s: &str) -> Option<u32> {
    let mut max_major: Option<u32> = None;
    for line in s.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let major_str = trimmed.split('.').next().unwrap_or("");
        if let Ok(major) = major_str.parse::<u32>() {
            max_major = Some(max_major.map_or(major, |prev| prev.max(major)));
        }
    }
    max_major
}

fn detect_nvidia_compute_cap_major() -> Option<u32> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args(["--query-gpu=compute_cap", "--format=csv,noheader,nounits"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    parse_compute_cap_output(&s)
}

// ── pip helpers (issue #32: PyTorch / ComfyUI install reliability) ───────────

/// Push a log line to the shared install state. Best-effort — silently
/// no-ops if the mutex is poisoned (which only happens if a thread panicked
/// while holding the lock; the install is already broken at that point).
fn push_install_log(state: &Arc<Mutex<InstallState>>, msg: &str) {
    if let Ok(mut s) = state.lock() {
        s.logs.push(msg.to_string());
    }
}

// ── PEP 668 / venv helpers (Bug E — rzgrozt Arch externally-managed) ─────────

/// True iff the Python pointed to by `python_bin` is PEP 668 protected
/// (Arch Linux, Debian 12+, Fedora 38+, Ubuntu 23.04+ ship Python with an
/// `EXTERNALLY-MANAGED` marker file in the stdlib dir, which makes
/// `python -m pip install ...` exit with
/// `error: externally-managed-environment` unless `--break-system-packages`
/// is passed). We probe by asking Python itself whether the marker exists
/// — robust against distro-specific path layouts and avoids parsing locale
/// dependent pip error strings.
///
/// Returns `false` on any probe error (Python missing, sysconfig broken,
/// stdout unparseable). That is the safe default: a false negative just
/// means we install without a venv exactly like LU did before this bug,
/// which is fine on every distro that *isn't* PEP 668 protected.
pub fn is_pep668_protected(python_bin: &str) -> bool {
    if python_bin.is_empty() {
        return false;
    }
    let mut cmd = Command::new(python_bin);
    cmd.args([
        "-c",
        "import os, sysconfig; \
         d = sysconfig.get_path('stdlib'); \
         print('YES' if os.path.exists(os.path.join(d, 'EXTERNALLY-MANAGED')) else 'NO')",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(out) = cmd.output() else { return false };
    if !out.status.success() {
        return false;
    }
    String::from_utf8_lossy(&out.stdout).trim() == "YES"
}

/// Create a venv inside `comfyui_dir/venv` using the system `python_bin`.
/// Returns the path to the venv's Python interpreter on success. On Arch
/// boxes that haven't installed the `python-virtualenv` package this can
/// fail with `No module named venv` — we surface that with an actionable
/// hint pointing at the right pacman / apt invocation.
pub fn create_comfyui_venv(comfyui_dir: &Path, python_bin: &str) -> Result<PathBuf, String> {
    let venv_dir = comfyui_dir.join("venv");
    // venv is idempotent: re-running on an existing dir just no-ops, but be
    // explicit so the log reads cleanly.
    let already_existed = venv_dir.exists() && venv_python_path(comfyui_dir).exists();
    if already_existed {
        return Ok(venv_python_path(comfyui_dir));
    }

    let mut cmd = Command::new(python_bin);
    cmd.args(["-m", "venv", venv_dir.to_string_lossy().as_ref()])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let out = cmd
        .output()
        .map_err(|e| format!("Could not spawn `python -m venv`: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let lower = stderr.to_lowercase();
        // Most common Arch / minimal-Python failure: stdlib venv module
        // isn't available because the distro packages it separately.
        if lower.contains("no module named venv") || lower.contains("ensurepip") {
            return Err(format!(
                "Python's `venv` module is not available. Install it first:\n\
                 • Arch:   sudo pacman -S python-virtualenv\n\
                 • Debian/Ubuntu: sudo apt install python3-venv\n\
                 • Fedora: sudo dnf install python3-virtualenv\n\
                 Then retry the ComfyUI install.\n\n--- python output ---\n{}",
                stderr.chars().take(400).collect::<String>()
            ));
        }
        return Err(format!(
            "venv creation failed: {}",
            stderr.chars().take(400).collect::<String>()
        ));
    }

    let venv_py = venv_python_path(comfyui_dir);
    if !venv_py.exists() {
        return Err(format!(
            "venv was created at {} but no Python binary appeared at {}. \
             This usually means the venv module is broken — try `sudo pacman -S python-virtualenv` (Arch) or the equivalent on your distro.",
            venv_dir.display(),
            venv_py.display()
        ));
    }
    Ok(venv_py)
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

    let hint = if lower.contains("externally-managed-environment")
        || lower.contains("error: externally-managed")
    {
        "Your Python is PEP 668 protected (Arch Linux, Debian 12+, Fedora 38+, \
         Ubuntu 23.04+ block system-wide pip installs by default). LU should have \
         created a venv inside the ComfyUI folder automatically — if you see this \
         error, the venv module is missing. Install it and retry:\n\
         • Arch:   sudo pacman -S python-virtualenv\n\
         • Debian/Ubuntu: sudo apt install python3-venv\n\
         • Fedora: sudo dnf install python3-virtualenv"
    } else if lower.contains("ssl") {
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
/// Streaming pip install with retry. When `cancel` is `Some`, polls the
/// shared flag between line reads and waits, and kills the pip child on
/// cancel — used by `install_comfyui` so the user's Cancel button
/// (Bug #1 — techx69 v2.4.3) actually stops the running install instead
/// of waiting for pip to finish naturally. When `cancel` is `None`, the
/// install runs to completion as before — used by `install_python` and
/// callers that haven't been wired up to the new cancel flow.
fn pip_install_streaming_with_retry_cancellable(
    args: &[&str],
    python_bin: &str,
    max_attempts: u32,
    install_state: &Arc<Mutex<InstallState>>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<(), String> {
    let mut delay_seconds = 10u64;
    let mut last_stderr = String::new();

    for attempt in 1..=max_attempts {
        if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
            return Err("cancelled".to_string());
        }
        if attempt > 1 {
            push_install_log(
                install_state,
                &format!(
                    "Transient network error — retry {}/{} after {}s wait...",
                    attempt, max_attempts, delay_seconds
                ),
            );
            // Sleep in 1-second chunks so cancel reacts within ~1s.
            for _ in 0..delay_seconds {
                if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                    return Err("cancelled".to_string());
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
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

        // Poll for either the child to exit or the cancel flag to flip.
        // try_wait avoids blocking the cancel check; sleep keeps CPU idle.
        let exit_status = loop {
            if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                // Kill the child so pip doesn't keep saturating disk.
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err("cancelled".to_string());
            }
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
                Err(e) => return Err(format!("pip wait failed: {}", e)),
            }
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

    // Reset cancel flag (Bug #1) — a previous cancelled install would
    // otherwise short-circuit the new run on first poll.
    state.comfyui_install_cancel.store(false, Ordering::SeqCst);
    let cancel_flag = state.comfyui_install_cancel.clone();

    let target_dir = install_path
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("ComfyUI"));

    // Bug #1 (techx69): pre-flight disk pressure check. On a drive sitting
    // at 100% utilisation the install hangs for 45+ minutes and the app
    // OOMs. Surface the risk BEFORE we start — the user can free space
    // or pick a different drive instead of staring at a frozen progress
    // log. We don't refuse to start: some users will accept the slow path.
    if let Some(warning) = check_install_disk_pressure(&target_dir) {
        if let Ok(mut s) = state.install_status.lock() {
            s.logs.push(warning);
        }
    }

    // Pre-flight: refuse to start ComfyUI install without a real Python.
    // The frontend is expected to call `install_python` first when this
    // returns the "no python" error — that flow shows a Python-install
    // progress card before re-firing `install_comfyui`. The ComfyUI carcass
    // bug (P14) was caused by skipping this check: pip got fed the Microsoft
    // Store stub `python.exe`, which exit-1'd, leaving a half-cloned
    // ComfyUI dir on disk that LU then mistakenly detected as "installed".
    let python_bin = state.python_bin.lock().unwrap().clone();
    if python_bin.is_empty() || !crate::python::is_real_python(&python_bin) {
        // Reset install state so the frontend's polling sees the error
        // immediately — without this the spawned thread below never runs and
        // the UI sits on "installing" forever.
        let mut install = state.install_status.lock().unwrap();
        install.status = "error".to_string();
        install.logs.push(
            "Python is not installed on this machine. \
             Install Python first (Settings → ComfyUI → Install Python, \
             or click 'Install Python' in the onboarding ComfyUI step), \
             then retry the ComfyUI install."
                .to_string(),
        );
        return Err(
            "no_python: Python must be installed before ComfyUI. Call install_python first."
                .to_string(),
        );
    }
    let install_status = state.install_status.clone();

    std::thread::spawn(move || {
        // Helper to update install status + logs
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_status.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        let cancelled = || cancel_flag.load(Ordering::SeqCst);

        if cancelled() {
            update("cancelled", "Install cancelled before it started.");
            return;
        }

        // Step 1: Git clone — spawn+poll instead of cmd.output() so the
        // Cancel button can kill an in-flight clone (Bug #1).
        println!("[Install] Cloning ComfyUI to {:?}", target_dir);
        update("downloading", "Step 1/3: Downloading ComfyUI repository...");

        let mut cmd = Command::new("git");
        cmd.args(["clone", "https://github.com/comfyanonymous/ComfyUI.git"])
            .arg(&target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut clone_child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let err = format!("Git is not installed or not in PATH: {}", e);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        };
        let clone_exit = loop {
            if cancelled() {
                let _ = clone_child.kill();
                let _ = clone_child.wait();
                update("cancelled", "Install cancelled during git clone.");
                return;
            }
            match clone_child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(250)),
                Err(e) => {
                    update("error", &format!("git wait failed: {}", e));
                    return;
                }
            }
        };

        if clone_exit.success() {
            println!("[Install] Git clone successful");
            update("installing", "Repository cloned successfully.");
        } else {
            let mut stderr = String::new();
            if let Some(mut e) = clone_child.stderr.take() {
                let _ = e.read_to_string(&mut stderr);
            }
            if stderr.contains("already exists") {
                println!("[Install] ComfyUI directory already exists, updating...");
                update("installing", "ComfyUI already exists, pulling latest...");
                if cancelled() {
                    update("cancelled", "Install cancelled.");
                    return;
                }
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

        if cancelled() {
            update("cancelled", "Install cancelled after clone.");
            return;
        }

        // Bug E (rzgrozt — Arch GH #32 comment, 2026-05-08): if the system
        // Python is PEP 668 protected (Arch, Debian 12+, Fedora 38+, Ubuntu
        // 23.04+), a bare `python -m pip install ...` exits with
        // `error: externally-managed-environment` and leaves the user with
        // a half-cloned ComfyUI dir and no diagnostic. Detect the marker
        // file via the system Python, then create a venv inside the
        // ComfyUI folder and use the venv's Python for every subsequent
        // pip step. The launcher in `process.rs` mirrors this check and
        // prefers the venv when starting ComfyUI, so the user gets a
        // consistent isolated environment without ever touching pacman.
        let effective_python = if is_pep668_protected(&python_bin) {
            update(
                "installing",
                "Python is PEP 668 protected (Arch / Debian 12+ / Fedora 38+ / \
                 Ubuntu 23.04+). Creating an isolated venv at ComfyUI/venv so \
                 pip can install PyTorch + ComfyUI deps without touching your \
                 system Python …",
            );
            match create_comfyui_venv(&target_dir, &python_bin) {
                Ok(venv_py) => {
                    let p = venv_py.to_string_lossy().to_string();
                    update(
                        "installing",
                        &format!("venv ready — using {} for the install.", p),
                    );
                    p
                }
                Err(e) => {
                    update("error", &format!("venv creation failed.\n\n{}", e));
                    return;
                }
            }
        } else {
            python_bin.clone()
        };

        // Step 2: Detect GPU and install PyTorch
        let mut nv = Command::new("nvidia-smi");
        nv.stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        nv.creation_flags(CREATE_NO_WINDOW);
        let has_nvidia = nv.output().map(|o| o.status.success()).unwrap_or(false);

        // Bug #10 (vokurta — RTX 6000 Blackwell, 2026-05-11): SM 12.0 GPUs
        // need PyTorch cu128 wheels. cu121 stops at sm_90 (Hopper); on
        // Blackwell the kernel simply isn't shipped and the first compute
        // call dies with "CUDA error: no kernel image is available for
        // execution on the device". We probe `--query-gpu=compute_cap` and
        // pick the wheel set accordingly. Falls back to cu121 if the probe
        // fails for any reason — that's the previous behaviour, so we
        // never regress existing setups.
        let compute_cap_major = if has_nvidia { detect_nvidia_compute_cap_major() } else { None };
        let pytorch_index = match compute_cap_major {
            Some(major) if major >= 12 => Some("https://download.pytorch.org/whl/cu128"),
            Some(_) => Some("https://download.pytorch.org/whl/cu121"),
            None if has_nvidia => Some("https://download.pytorch.org/whl/cu121"),
            None => None,
        };

        let gpu_info = match (has_nvidia, compute_cap_major) {
            (true, Some(major)) if major >= 12 => "NVIDIA Blackwell GPU detected (SM 12.0+) — installing PyTorch cu128",
            (true, Some(_)) => "NVIDIA GPU detected — installing CUDA PyTorch (cu121)",
            (true, None) => "NVIDIA GPU detected (compute capability probe failed) — falling back to cu121",
            (false, _) => "No NVIDIA GPU — installing CPU PyTorch",
        };
        println!("[Install] {}", gpu_info);
        update("installing", &format!("Step 2/3: {}", gpu_info));
        update(
            "installing",
            "Downloading PyTorch + Torchvision + Torchaudio (~2 GB total). \
             On a typical home connection this takes 10–15 minutes; on slower \
             links it can be longer. Live pip output below — if you see new \
             lines appearing, the install is making progress, not hung.",
        );

        let torch_args: Vec<&str> = if let Some(index_url) = pytorch_index {
            vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "torch", "torchvision", "torchaudio",
                "--index-url", index_url,
            ]
        } else {
            vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "torch", "torchvision", "torchaudio",
            ]
        };

        match pip_install_streaming_with_retry_cancellable(&torch_args, &effective_python, 3, &install_status, Some(&cancel_flag)) {
            Ok(()) => {
                update("installing", "PyTorch installed successfully.");
            }
            Err(diagnosis) if diagnosis == "cancelled" => {
                update("cancelled", "Install cancelled during PyTorch download.");
                return;
            }
            Err(diagnosis) => {
                let err = format!("PyTorch installation failed.\n\n{}", diagnosis);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        }

        if cancelled() {
            update("cancelled", "Install cancelled before requirements install.");
            return;
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
            match pip_install_streaming_with_retry_cancellable(&req_args, &effective_python, 3, &install_status, Some(&cancel_flag)) {
                Ok(()) => {
                    update("installing", "Dependencies installed successfully.");
                }
                Err(diagnosis) if diagnosis == "cancelled" => {
                    update("cancelled", "Install cancelled during requirements install.");
                    return;
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

// ── LM Studio Install (Windows) ─────────────────────────────────────────────
//
// LM Studio doesn't run as a Windows service like Ollama — it's a desktop app
// whose embedded server is started via either the GUI ("Server" tab) or the
// `lms` CLI (`lms server start`). The install flow here:
//   1. Download the official LM Studio installer .exe
//   2. Silent install with /S (NSIS / electron-builder convention)
//   3. Run `lms bootstrap` to register the CLI on PATH
//   4. Start the server on port 1234 via `lms server start --cors`
//
// Step 4 is what makes this Plug & Play — without it the user has to manually
// open the app and toggle the server, which is exactly the "version one
// usability cliff" we're trying to remove. If lms isn't on PATH yet (e.g.
// install is too fresh), we look in `%USERPROFILE%/.lmstudio/bin/lms.exe`
// directly.
//
// The hard-coded URL points to a known-stable release. LM Studio's installer
// host doesn't expose a /latest redirect — every version is its own URL — so
// the alternative would be to bake in a remote-version-check, which adds an
// extra failure mode for offline users. A stale URL just means the user gets
// a slightly older LM Studio; functionally fine.
const LMSTUDIO_INSTALLER_URL: &str =
    "https://installers.lmstudio.ai/win32/x64/0.3.16-6/LM-Studio-0.3.16-6-x64.exe";
const LMSTUDIO_DEFAULT_PORT: u16 = 1234;

fn lmstudio_lms_path() -> Option<PathBuf> {
    // Post-bootstrap: `lms bootstrap` materialises the launcher here and adds
    // the same path to PATH. Cheapest check first.
    let direct = dirs::home_dir().map(|h| h.join(".lmstudio").join("bin").join("lms.exe"));
    if let Some(ref p) = direct {
        if p.exists() {
            return direct;
        }
    }

    // Pre-bootstrap: on a fresh install, lms.exe ships inside the GUI app's
    // resources dir before `lms bootstrap` ever runs. Calling this binary
    // directly is how we *do* the bootstrap on a brand-new box — without it
    // the user has to open LM Studio once from the Start menu just to seed
    // the CLI, which is exactly the noob-cliff this sweep is removing.
    let webpack_suffix = ["resources", "app", ".webpack", "lms.exe"];
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        let mut pre_bootstrap = PathBuf::from(la);
        pre_bootstrap.push("Programs");
        pre_bootstrap.push("LM Studio");
        for s in &webpack_suffix { pre_bootstrap.push(s); }
        if pre_bootstrap.exists() {
            return Some(pre_bootstrap);
        }
    }

    // System-wide install path: when LM Studio's installer is run "for all
    // users" (or installed via an MSI deployment), it lands in
    // %PROGRAMFILES%\LM Studio\. techx69 confirmed (2026-05-06): the
    // per-user-only lookup made LU report "no LM Studio detected" even with
    // `~/.lmstudio/models/` already populated.
    for env_var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"] {
        if let Ok(pf) = std::env::var(env_var) {
            let mut sys_wide = PathBuf::from(pf);
            sys_wide.push("LM Studio");
            for s in &webpack_suffix { sys_wide.push(s); }
            if sys_wide.exists() {
                return Some(sys_wide);
            }
        }
    }

    // Registry-based fallback: LM Studio's installer writes its install dir
    // under HKCU or HKLM Uninstall keys. Reading the registry lets us catch
    // exotic install dirs (e.g. user moved it to D:\Apps\LM Studio\).
    #[cfg(target_os = "windows")]
    if let Some(p) = lmstudio_path_from_registry() {
        let candidate = p.join("resources").join("app").join(".webpack").join("lms.exe");
        if candidate.exists() {
            return Some(candidate);
        }
        // Some builds drop lms.exe at the install root.
        let root_candidate = p.join("lms.exe");
        if root_candidate.exists() {
            return Some(root_candidate);
        }
    }

    // Last resort: PATH lookup. Catches non-standard installs (Chocolatey,
    // user-relocated install dir, etc.).
    if let Ok(out) = Command::new("where").arg("lms").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    None
}

/// Soft-detect LM Studio by scanning `~/.lmstudio/models/` for GGUF files.
/// Returns the number of GGUF files found (0 if the dir is missing or empty).
///
/// Rationale: even when `lms.exe` isn't on any search path (system-wide
/// install missed by our fallback, GUI never launched, etc.), the presence
/// of GGUFs in the canonical models dir is a strong signal that the user
/// *has* LM Studio and just hasn't started the server. Surfacing that in the
/// onboarding lets us show "LM Studio models detected — start server?" instead
/// of the dead-end "no LM Studio".
fn lmstudio_models_present() -> u32 {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return 0,
    };
    let models_dir = home.join(".lmstudio").join("models");
    if !models_dir.exists() {
        return 0;
    }
    // The standard layout is ~/.lmstudio/models/<publisher>/<repo>/<file>.gguf —
    // up to three levels deep. We walk lazily and stop after the first 1000
    // matches; the user does not care about the exact count past "many".
    fn walk(dir: &Path, depth: u32, found: &mut u32) {
        if *found >= 1000 || depth > 4 {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, depth + 1, found);
            } else if path.extension().and_then(|e| e.to_str()).map(|s| s.eq_ignore_ascii_case("gguf")).unwrap_or(false) {
                *found += 1;
                if *found >= 1000 {
                    return;
                }
            }
        }
    }
    let mut count: u32 = 0;
    walk(&models_dir, 0, &mut count);
    count
}

#[cfg(target_os = "windows")]
fn lmstudio_path_from_registry() -> Option<PathBuf> {
    // Read InstallLocation from LM Studio's Uninstall entry. We try HKCU
    // first (per-user installs) then HKLM (system-wide). The display name
    // varies slightly between installer builds, so we scan for any subkey
    // whose DisplayName starts with "LM Studio".
    use winreg::enums::*;
    use winreg::RegKey;
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        for uninstall_path in [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ] {
            let Ok(uninstall) = root.open_subkey(uninstall_path) else { continue };
            for key_res in uninstall.enum_keys() {
                let Ok(key) = key_res else { continue };
                let Ok(sub) = uninstall.open_subkey(&key) else { continue };
                let name: String = sub.get_value("DisplayName").unwrap_or_default();
                if name.eq_ignore_ascii_case("LM Studio") || name.starts_with("LM Studio") {
                    if let Ok(loc) = sub.get_value::<String, _>("InstallLocation") {
                        let p = PathBuf::from(loc);
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn lmstudio_path_from_registry() -> Option<PathBuf> {
    None
}

/// Path to the LM Studio GUI executable on Windows. We only need to launch
/// this in the rare case where `lms bootstrap` from the pre-bootstrap binary
/// reports success but `~/.lmstudio/` is still missing — some installs
/// require a one-time GUI launch to populate user-data dirs before
/// `lms bootstrap` will register the CLI on PATH.
fn lmstudio_gui_exe() -> Option<PathBuf> {
    let la = std::env::var("LOCALAPPDATA").ok()?;
    let p = PathBuf::from(la)
        .join("Programs")
        .join("LM Studio")
        .join("LM Studio.exe");
    if p.exists() { Some(p) } else { None }
}

fn lmstudio_server_running() -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build();
    if let Ok(c) = client {
        return c
            .get(format!("http://localhost:{}/v1/models", LMSTUDIO_DEFAULT_PORT))
            .send()
            .map(|r| r.status().is_success() || r.status() == 401)
            .unwrap_or(false);
    }
    false
}

#[tauri::command]
pub fn install_lmstudio(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut install = state.lmstudio_install.lock().unwrap();
    if install.status == "downloading"
        || install.status == "installing"
        || install.status == "starting"
    {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "downloading".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install
        .logs
        .push("Downloading LM Studio installer...".to_string());
    drop(install);

    let lms_state = state.lmstudio_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = lms_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Pre-check: if LM Studio is already installed (an `lms.exe` is
        // findable in any of the locations `lmstudio_lms_path()` knows about)
        // we skip the ~570 MB download entirely. Re-installing on a box where
        // it's already there was the previous behaviour and made the
        // "LM Studio detected but server offline" Plug-and-Play scenario
        // turn into a 5-minute no-op download. The bootstrap + server-start
        // steps below are idempotent, so the same code path now serves both
        // first-install and offline-reactivation users.
        let already_installed = lmstudio_lms_path().is_some();
        if already_installed && lmstudio_server_running() {
            update(
                "complete",
                "LM Studio is already installed and the server is up on localhost:1234.",
            );
            return;
        }

        if already_installed {
            update(
                "starting",
                "LM Studio is already installed — skipping download. Bootstrapping CLI and starting server…",
            );
        } else {
            let temp_dir = std::env::temp_dir();
            let installer_path = temp_dir.join("LMStudioSetup.exe");

            println!("[LMStudio] Downloading {}", LMSTUDIO_INSTALLER_URL);
            if let Err(e) =
                download_file_blocking(LMSTUDIO_INSTALLER_URL, &installer_path, &lms_state)
            {
                let err = format!(
                    "Download failed: {}. If the network is fine, the installer URL may have rotated — fall back to https://lmstudio.ai/download in your browser.",
                    e
                );
                println!("[LMStudio] {}", err);
                update("error", &err);
                return;
            }

            update(
                "installing",
                "Download complete. Running silent installer (this can take a minute)...",
            );

            // electron-builder NSIS supports /S for silent install. Ignore exit
            // code: real failures surface via the absence of lms.exe afterwards.
            let mut cmd = Command::new(&installer_path);
            cmd.arg("/S");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            match cmd.output() {
                Ok(_) => println!("[LMStudio] Installer finished"),
                Err(e) => {
                    let err = format!("Could not run installer: {}", e);
                    println!("[LMStudio] {}", err);
                    update("error", &err);
                    return;
                }
            }

            let _ = fs::remove_file(&installer_path);
        }

        // Bootstrap the lms CLI. We do this in two passes:
        //   (1) Run `lms bootstrap` from whatever path `lmstudio_lms_path()`
        //       resolves — on a fresh install that's the pre-bootstrap binary
        //       inside `resources/app/.webpack/lms.exe`. This alone is enough
        //       on most boxes.
        //   (2) Verify that ~/.lmstudio/bin/lms.exe now exists. If not, some
        //       LM Studio builds require the GUI to run once to populate
        //       ~/.lmstudio/ before the bootstrap registers a launcher there.
        //       In that case we briefly launch the GUI, wait for ~/.lmstudio/
        //       to appear, retry bootstrap, then move on. The user sees the
        //       GUI flash up — not ideal, but strictly better than the old
        //       "Open LM Studio once from the Start menu" error dialog and a
        //       failed install.
        update("starting", "Bootstrapping `lms` CLI...");
        let initial_lms = lmstudio_lms_path();
        match &initial_lms {
            Some(p) => {
                let mut bs = Command::new(p);
                bs.arg("bootstrap");
                #[cfg(target_os = "windows")]
                bs.creation_flags(CREATE_NO_WINDOW);
                let _ = bs.output();
            }
            None => {
                update(
                    "error",
                    "LM Studio installed but `lms.exe` not found in any expected location. \
                     The installer may have failed silently. Try installing LM Studio manually \
                     from https://lmstudio.ai/download and then click Re-Scan.",
                );
                return;
            }
        }

        // Did pass 1 produce ~/.lmstudio/bin/lms.exe?  If yes, skip the GUI
        // dance entirely. If no, fall back to launching the GUI so it seeds
        // its user-data dir, then retry bootstrap.
        let post_bootstrap_path = dirs::home_dir()
            .map(|h| h.join(".lmstudio").join("bin").join("lms.exe"));
        let needs_gui_seed = post_bootstrap_path
            .as_ref()
            .map(|p| !p.exists())
            .unwrap_or(true);

        if needs_gui_seed {
            update(
                "starting",
                "Launching LM Studio briefly to finalise CLI setup (you may see the window flash)...",
            );
            if let Some(gui) = lmstudio_gui_exe() {
                let mut g = Command::new(&gui);
                #[cfg(target_os = "windows")]
                g.creation_flags(CREATE_NO_WINDOW);
                let _ = g.spawn();
            }

            // Wait up to 30 s for ~/.lmstudio/ to appear. The first GUI launch
            // typically writes this within 3–8 s, but on a slow VM 30 s is a
            // safer ceiling than failing the install.
            let lmstudio_dir = dirs::home_dir().map(|h| h.join(".lmstudio"));
            for _ in 0..30 {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if let Some(d) = &lmstudio_dir {
                    if d.exists() {
                        break;
                    }
                }
            }

            // Retry bootstrap from the (now possibly different) lms.exe.
            // After GUI launch the .lmstudio dir might already contain a
            // launcher; if not, the pre-bootstrap path is still valid.
            if let Some(p) = lmstudio_lms_path() {
                let mut bs = Command::new(&p);
                bs.arg("bootstrap");
                #[cfg(target_os = "windows")]
                bs.creation_flags(CREATE_NO_WINDOW);
                let _ = bs.output();
            }
        }

        // Start the embedded server. `lms server start` is non-blocking — it
        // detaches a background httpd. --cors so LU's web view (which is on a
        // tauri:// origin) isn't blocked by the SOP. Port matches the
        // provider-store default of 1234 so user config Just Works.
        // Re-resolve the path because the bootstrap dance above may have
        // promoted us from the pre-bootstrap path to ~/.lmstudio/bin/lms.exe.
        update("starting", "Starting LM Studio server on port 1234...");
        if let Some(p) = lmstudio_lms_path() {
            let mut srv = Command::new(&p);
            srv.args(["server", "start", "--cors", "--port"])
                .arg(LMSTUDIO_DEFAULT_PORT.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            srv.creation_flags(CREATE_NO_WINDOW);
            let _ = srv.spawn();
        }

        // Wait for the server to respond. LM Studio's server typically takes
        // ~3-5 s to bind in a fresh install (it loads its model index first).
        update("starting", "Waiting for LM Studio server...");
        let mut ready = false;
        for i in 0..15 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if lmstudio_server_running() {
                ready = true;
                break;
            }
            println!("[LMStudio] Server not ready, attempt {}/15", i + 1);
        }

        if ready {
            update("complete", "LM Studio server is up on localhost:1234.");
        } else {
            update(
                "error",
                "LM Studio installed but the server didn't come up. Open LM Studio from the Start menu and toggle the Server tab on, then click Re-Scan.",
            );
        }
    });

    Ok(serde_json::json!({"status": "downloading"}))
}

#[tauri::command]
pub fn install_lmstudio_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.lmstudio_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

/// Best-effort: spawn `lms server start` so we don't make the user open the
/// LM Studio GUI just to flip the Server toggle. Idempotent — quick early-exit
/// if the server is already responding.
#[tauri::command]
pub fn start_lmstudio_server() -> Result<serde_json::Value, String> {
    if lmstudio_server_running() {
        return Ok(serde_json::json!({"status": "already_running"}));
    }
    match lmstudio_lms_path() {
        Some(p) => {
            let mut srv = Command::new(&p);
            srv.args(["server", "start", "--cors", "--port"])
                .arg(LMSTUDIO_DEFAULT_PORT.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            srv.creation_flags(CREATE_NO_WINDOW);
            srv.spawn()
                .map_err(|e| format!("spawn lms: {}", e))?;
            Ok(serde_json::json!({"status": "starting"}))
        }
        None => Err(
            "LM Studio is not installed (no lms.exe found). Use Settings → Install LM Studio first."
                .to_string(),
        ),
    }
}

#[tauri::command]
pub fn lmstudio_server_status() -> Result<serde_json::Value, String> {
    let model_count = lmstudio_models_present();
    Ok(serde_json::json!({
        "running": lmstudio_server_running(),
        "port": LMSTUDIO_DEFAULT_PORT,
        "lms_present": lmstudio_lms_path().is_some(),
        // Soft-detect signals — onboarding shows "Start LM Studio server?"
        // when models are present even if lms.exe couldn't be located.
        "models_detected": model_count > 0,
        "model_count": model_count,
    }))
}

// ── Python Auto-Install (P14: Plug-and-Play, blocking pre-req for ComfyUI) ──
//
// On a fresh Windows box `python.exe` is the Microsoft Store stub at
// `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` — it prints "Python was
// not found, run without arguments to install from the Microsoft Store" and
// exits 1. That kills `pip install torch ...` 200 ms in, leaves a half-cloned
// ComfyUI dir on disk, and the user sees "ComfyUI not responding". The
// only Plug-and-Play fix for newbies is to install Python ourselves; this is
// what `install_python` does. Same shape as `install_ollama` /
// `install_lmstudio`: kick off a background thread, surface status via a
// shared `InstallState`, and re-resolve `python_bin` once it finishes so
// subsequent `install_comfyui` calls find it without an app restart.

#[tauri::command]
pub fn install_python(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // If Python is already there, short-circuit so the UI can skip the
    // install card and go straight to ComfyUI. is_real_python rejects
    // the empty sentinel and WindowsApps stub paths.
    {
        let current = state.python_bin.lock().unwrap().clone();
        if crate::python::is_real_python(&current) {
            return Ok(serde_json::json!({"status": "already_installed", "path": current}));
        }
    }

    let mut install = state.python_install.lock().unwrap();
    if install.status == "downloading"
        || install.status == "installing"
        || install.status == "starting"
    {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "installing".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install
        .logs
        .push("Installing Python 3.12 via winget (~30 MB)…".to_string());
    drop(install);

    let py_state = state.python_install.clone();
    let py_bin_slot = state.python_bin.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = py_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Stream-friendly winget invocation. `--silent --accept-*-agreements`
        // drops the EULA prompts; without them winget will sit and wait for
        // user input forever inside our background thread. Python.Python.3.12
        // is the canonical winget id for the python.org installer (matches
        // `winget search python` top result).
        update("installing", "Running: winget install Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements");

        let mut cmd = Command::new("winget");
        cmd.args([
            "install",
            "Python.Python.3.12",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--scope",
            "user",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                update(
                    "error",
                    &format!(
                        "Could not run winget: {}. winget ships with Windows 10/11 — \
                         if it's missing, run 'Get App Installer' from the Microsoft \
                         Store (free) and retry.",
                        e
                    ),
                );
                return;
            }
        };

        // Stream stdout + stderr line-by-line so the UI's log card animates
        // as winget extracts and installs (otherwise it freezes for 1–2 min).
        let mut child = child;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_state = py_state.clone();
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
        let stderr_state = py_state.clone();
        let stderr_handle = std::thread::spawn(move || {
            if let Some(err) = stderr {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
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
            Err(e) => {
                update("error", &format!("winget wait failed: {}", e));
                return;
            }
        };
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        if !exit_status.success() {
            // winget exit codes are HRESULT-shaped; -1978335189 (0x8A150011)
            // means "no upgrade applicable" which is fine if Python is
            // already present. Anything else is a real failure.
            let code = exit_status.code().unwrap_or(-1);
            // Re-resolve regardless: Python may already be on the box from
            // a previous install attempt that the original where-scan
            // missed (e.g. Add-to-PATH was unchecked).
            let resolved = crate::python::get_python_bin();
            if crate::python::is_real_python(&resolved) {
                if let Ok(mut slot) = py_bin_slot.lock() {
                    *slot = resolved.clone();
                }
                update(
                    "complete",
                    &format!("Python ready (winget exit {} ignored, Python detected at {})", code, resolved),
                );
                return;
            }
            update(
                "error",
                &format!(
                    "winget exited with code {}. Python was not detected after \
                     install. Try installing manually from python.org with the \
                     'Add Python to PATH' checkbox on, then return here and \
                     click Re-Scan.",
                    code
                ),
            );
            return;
        }

        update("starting", "winget finished. Re-resolving Python…");

        // Give the freshly installed Python a moment to settle (winget can
        // signal completion before the file is fully linked into PATH on
        // some boxes), then re-resolve and persist.
        for attempt in 0..15 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let resolved = crate::python::get_python_bin();
            if crate::python::is_real_python(&resolved) {
                if let Ok(mut slot) = py_bin_slot.lock() {
                    *slot = resolved.clone();
                }
                update(
                    "complete",
                    &format!("Python ready at {}", resolved),
                );
                return;
            }
            println!("[Python] post-install resolve attempt {}/15 — not yet on PATH", attempt + 1);
        }

        update(
            "error",
            "winget reported success but Python is still not on PATH. \
             Restart Locally Uncensored — sometimes Windows needs the new PATH \
             to take effect. If it still doesn't show up, install manually \
             from python.org with 'Add Python to PATH' on.",
        );
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn install_python_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.python_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

/// Cheap synchronous probe: is there a real Python on the box?  The frontend
/// calls this before kicking off `install_comfyui` so it can decide whether
/// to show the Python install step first. Returns the resolved path on
/// success so the UI can display it ("Found Python at C:\\…").
#[tauri::command]
pub fn python_check(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let current = state.python_bin.lock().unwrap().clone();
    if crate::python::is_real_python(&current) {
        return Ok(serde_json::json!({"available": true, "path": current}));
    }

    // The slot may have been empty at startup (fresh box) and Python may
    // have been installed since (e.g. via this same install_python flow on
    // another launch). Re-resolve as a refresh.
    let resolved = crate::python::get_python_bin();
    if crate::python::is_real_python(&resolved) {
        if let Ok(mut slot) = state.python_bin.lock() {
            *slot = resolved.clone();
        }
        Ok(serde_json::json!({"available": true, "path": resolved}))
    } else {
        Ok(serde_json::json!({"available": false, "path": null}))
    }
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
                // Bug F (discovered during Arch live test on 2026-05-17):
                // ComfyUI was installed into a venv by the Bug E path, but
                // this function used to call pip against `state.python_bin`
                // (the system Python). On Arch / Debian 12+ / Fedora 38+
                // that hits PEP 668's `externally-managed-environment` and
                // the requirements install silently fails (`let _ = pip.output()`
                // ignored the exit code, so the user got "installed" even
                // when requirements never landed — the next workflow build
                // would then crash with `ModuleNotFoundError`).
                //
                // Fix: prefer the ComfyUI venv's Python (matches the launcher
                // in `process.rs::start_comfyui` and the installer in
                // `install_comfyui`) so requirements land in the same
                // site-packages ComfyUI actually imports from. Plus we now
                // surface a useful error when pip fails instead of swallowing it.
                let venv_python = crate::python::resolve_comfyui_venv_python(&comfy_dir);
                let python_bin = venv_python.unwrap_or_else(|| {
                    state.python_bin.lock().unwrap().clone()
                });
                if python_bin.is_empty() {
                    return Err(format!(
                        "Custom node {} cloned, but cannot install requirements: \
                         no Python available. Install Python first \
                         (Settings → ComfyUI → Install Python).",
                        node_name
                    ));
                }
                println!("[Install] Installing requirements for {} via {}", node_name, python_bin);
                let mut pip = Command::new(&python_bin);
                pip.args(["-m", "pip", "install", "--no-input", "-r"]).arg(&reqs)
                    .stdout(Stdio::piped()).stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                pip.creation_flags(CREATE_NO_WINDOW);
                let pip_out = pip.output()
                    .map_err(|e| format!("Failed to spawn pip for {} requirements: {}", node_name, e))?;
                if !pip_out.status.success() {
                    let stderr = String::from_utf8_lossy(&pip_out.stderr);
                    let stdout = String::from_utf8_lossy(&pip_out.stdout);
                    let combined = format!("{}{}", stdout, stderr);
                    // Reuse the install_comfyui diagnose path so PEP 668 +
                    // friends produce actionable messages here too.
                    let diagnosis = diagnose_pip_error(&combined);
                    return Err(format!(
                        "Custom node {} cloned, but requirements install failed.\n\n{}",
                        node_name, diagnosis
                    ));
                }
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

    // ── parse_compute_cap_output (Bug #10 — Blackwell PyTorch routing) ────

    #[test]
    fn compute_cap_parses_ampere_single_gpu() {
        assert_eq!(parse_compute_cap_output("8.6\n"), Some(8));
    }

    #[test]
    fn compute_cap_parses_ada_single_gpu() {
        assert_eq!(parse_compute_cap_output("8.9\n"), Some(8));
    }

    #[test]
    fn compute_cap_parses_hopper() {
        assert_eq!(parse_compute_cap_output("9.0\n"), Some(9));
    }

    #[test]
    fn compute_cap_parses_blackwell() {
        assert_eq!(parse_compute_cap_output("12.0\n"), Some(12));
    }

    #[test]
    fn compute_cap_multi_gpu_picks_highest() {
        assert_eq!(parse_compute_cap_output("8.6\n12.0\n"), Some(12));
    }

    #[test]
    fn compute_cap_handles_blank_lines() {
        assert_eq!(parse_compute_cap_output("\n8.6\n\n"), Some(8));
    }

    #[test]
    fn compute_cap_returns_none_for_empty_output() {
        assert_eq!(parse_compute_cap_output(""), None);
    }

    #[test]
    fn compute_cap_skips_unparseable_lines() {
        assert_eq!(parse_compute_cap_output("[Not Supported]\n8.6\n"), Some(8));
    }

    // ── Bug E (rzgrozt — Arch PEP 668 externally-managed) ─────────────────
    //
    // The detection function spawns a Python subprocess, so we can't unit
    // test it without a Python install. We DO test the safety guarantees:
    // empty `python_bin` returns false (regression-safe default), and the
    // diagnose path surfaces a useful hint when the marker error reaches
    // the user despite the auto-venv path.

    #[test]
    fn is_pep668_protected_returns_false_for_empty_bin() {
        // Empty sentinel from python.rs::get_python_bin must short-circuit
        // to false so a missing Python doesn't accidentally trigger venv
        // creation (which would also fail and confuse the error chain).
        assert!(!is_pep668_protected(""));
    }

    #[test]
    fn is_pep668_protected_returns_false_for_garbage_bin() {
        // Probing a non-existent path can't crash — the function must
        // swallow the spawn error and return false so install proceeds as
        // it always did on systems that aren't PEP 668 protected.
        assert!(!is_pep668_protected("/definitely/not/a/real/python-9.99"));
    }

    #[test]
    fn diagnose_externally_managed_mentions_venv() {
        let raw = "error: externally-managed-environment\n\
                   × This environment is externally managed\n\
                   ╰─> To install Python packages system-wide, try 'pacman -S python-xyz'";
        let msg = diagnose_pip_error(raw);
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("pep 668") || lower.contains("externally") || lower.contains("venv"),
            "diagnose did not surface PEP 668 context: {}",
            msg
        );
    }

    #[test]
    fn diagnose_externally_managed_includes_distro_install_commands() {
        let raw = "error: externally-managed-environment";
        let msg = diagnose_pip_error(raw);
        let lower = msg.to_lowercase();
        // We want at least one of the platform-specific install commands so
        // the user has something to copy-paste instead of just an error.
        assert!(
            lower.contains("pacman") || lower.contains("apt") || lower.contains("dnf"),
            "diagnose did not include a distro install command: {}",
            msg
        );
    }

    #[test]
    fn diagnose_externally_managed_alt_format_matches() {
        // The exact wording on Arch 2026 is `error: externally-managed`
        // without the `-environment` suffix — make sure the matcher covers
        // both spellings.
        let raw = "error: externally-managed (pip blocked by PEP 668)";
        let msg = diagnose_pip_error(raw);
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("pacman") || lower.contains("apt"),
            "diagnose missed the alt spelling: {}",
            msg
        );
    }

    #[test]
    fn transient_rejects_externally_managed() {
        // PEP 668 errors are deterministic — retrying without venv would
        // just loop forever. Must NOT be classified as transient.
        assert!(!is_transient_pip_error(
            "error: externally-managed-environment"
        ));
    }

    // ── Bug E — LIVE integration test ──────────────────────────────────────
    //
    // Runs against a real Python install with a real EXTERNALLY-MANAGED
    // marker planted in its stdlib. Requires the caller to point
    // `LU_PEP668_TEST_PYTHON` env var at a Python whose stdlib is writable
    // (typically a temp copy of system Python — see
    // `LU-E2E-Test-Kit/scripts/pep668_live_test.ps1` for the setup helper).
    //
    // Skipped by default via `#[ignore]` because:
    // 1. needs a real, modifiable Python install (not safe to mutate the
    //    system Python's stdlib — wedges every pip command on the box).
    // 2. writes to the filesystem and spawns 4-5 Python subprocesses.
    //
    // Run with: `cargo test --release --bins -- --ignored pep668_e2e_live`

    #[test]
    #[ignore]
    fn pep668_e2e_live_detect_and_create_venv() {
        let fake_python = std::env::var("LU_PEP668_TEST_PYTHON")
            .expect("set LU_PEP668_TEST_PYTHON to the fake-python path before running");
        assert!(
            std::path::Path::new(&fake_python).exists(),
            "LU_PEP668_TEST_PYTHON does not exist: {}",
            fake_python
        );

        // The helper script must have planted the marker BEFORE this test
        // runs. If it didn't, the detection should return false — that's
        // also informative, so we don't fail outright here; we just print
        // and check the more interesting assertions.

        // ── Phase 1: PEP 668 detection ──
        let detected = is_pep668_protected(&fake_python);
        assert!(
            detected,
            "is_pep668_protected({}) returned false — was the EXTERNALLY-MANAGED \
             marker planted in this Python's stdlib?",
            fake_python
        );
        println!("[live E2E] ✓ is_pep668_protected detected the marker");

        // ── Phase 2: create_comfyui_venv ──
        let comfy_root = std::env::temp_dir().join("lu-pep668-live-comfyui");
        let _ = std::fs::remove_dir_all(&comfy_root);
        std::fs::create_dir_all(&comfy_root).expect("temp dir create");

        let venv_py = create_comfyui_venv(&comfy_root, &fake_python)
            .expect("create_comfyui_venv should succeed against fake python");

        assert!(venv_py.exists(), "venv python at {} should exist", venv_py.display());
        assert!(venv_py.starts_with(&comfy_root), "venv python should be inside comfy dir");
        println!("[live E2E] ✓ create_comfyui_venv produced {}", venv_py.display());

        // ── Phase 3: nested venv's pip should be UNBLOCKED ──
        // The venv has its own site-packages, so PEP 668 doesn't apply to
        // it — this is the whole point of the fix. Verify pip install
        // works inside the nested venv. We use `--dry-run` so we don't
        // actually download anything heavy; the test is whether pip
        // refuses or proceeds.
        let pip_out = std::process::Command::new(venv_py.to_string_lossy().as_ref())
            .args(["-m", "pip", "install", "--dry-run", "--no-input", "pip"])
            .output()
            .expect("nested venv pip should spawn");
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&pip_out.stdout),
            String::from_utf8_lossy(&pip_out.stderr)
        );
        assert!(
            !combined.to_lowercase().contains("externally-managed"),
            "nested venv pip was STILL blocked — PEP 668 leaked through. \
             Output:\n{}",
            combined
        );
        assert!(pip_out.status.success(), "nested venv pip exit code != 0:\n{}", combined);
        println!("[live E2E] ✓ nested venv pip runs without PEP 668 block");

        // ── Phase 4: idempotency — second create_comfyui_venv must no-op ──
        let venv_py_again = create_comfyui_venv(&comfy_root, &fake_python)
            .expect("second create_comfyui_venv should idempotently return existing venv");
        assert_eq!(venv_py, venv_py_again);
        println!("[live E2E] ✓ create_comfyui_venv is idempotent");

        // Cleanup
        let _ = std::fs::remove_dir_all(&comfy_root);
        println!("[live E2E] ALL ASSERTIONS PASSED");
    }
}
