use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::state::AppState;

/// Windows: hide console windows for spawned processes
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Assign a child process to a Windows Job Object with KILL_ON_JOB_CLOSE.
/// When the Tauri parent process dies (even via Task Manager), the OS kernel
/// automatically terminates all processes in the job — no Drop needed.
#[cfg(target_os = "windows")]
fn assign_to_kill_on_close_job(child: &std::process::Child) {
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::Foundation::*;

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() { return; }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );

        // Open process handle from PID
        let pid = child.id();
        let handle = windows_sys::Win32::System::Threading::OpenProcess(
            windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA
            | windows_sys::Win32::System::Threading::PROCESS_TERMINATE,
            0, // FALSE
            pid,
        );
        if !handle.is_null() {
            AssignProcessToJobObject(job, handle);
            CloseHandle(handle);
        }
        // Intentionally leak the job handle — it must stay alive for the duration
        // of the parent process. When the parent dies, the handle is closed by the
        // OS and KILL_ON_JOB_CLOSE triggers.
    }
}

/// Show the main window (called from frontend after React renders)
#[tauri::command]
pub fn show_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
    }
}

/// Skip these directories during ComfyUI search
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "__pycache__", "venv", ".venv", "site-packages",
    "Windows", "Program Files", "Program Files (x86)", "$Recycle.Bin", "AppData",
];

fn scan_for_comfyui(dir: &Path, depth: u32) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return None,
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue, // Skip entries with permission errors
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || SKIP_DIRS.contains(&name_str.as_ref()) {
            continue;
        }
        let full = entry.path();
        // Check if this directory IS ComfyUI
        if name_str.eq_ignore_ascii_case("comfyui") && full.join("main.py").exists() {
            return Some(full);
        }
        // Recurse deeper
        if let Some(found) = scan_for_comfyui(&full, depth - 1) {
            return Some(found);
        }
    }
    None
}

/// Heuristic: does this ComfyUI directory look like a *complete* install,
/// i.e. one that will actually start when we run `python main.py`?
///
/// "Complete" here means: torch is reachable. Two paths qualify:
///
/// 1. Portable variants ship a `python_embeded/` directory with the
///    matching torch wheel pre-baked. We just check that
///    `python_embeded/Lib/site-packages/torch/` exists — fast and avoids
///    spawning a Python process for every dir we scan.
/// 2. From-source installs depend on the system Python having torch.
///    `python_embeded/` won't exist; we sniff the system Python's
///    `Lib/site-packages/torch/` instead. (Best-effort: we only check the
///    canonical "next to python.exe" layout — virtualenvs aren't covered,
///    but those users wouldn't be using LU's auto-install path anyway.)
///
/// Returning `false` for a `main.py`-only carcass is the whole point of
/// P14: a half-cloned ComfyUI dir from a previous abort (Python missing,
/// pip 403, network drop) used to be detected as "installed", which left
/// the user staring at "ComfyUI not responding" forever. Reporting it as
/// incomplete instead lets the install flow retry cleanly.
fn is_comfyui_install_complete(comfy_path: &Path) -> bool {
    if !comfy_path.join("main.py").exists() {
        return false;
    }

    // Path 1: portable layouts (next-to or inside the ComfyUI dir).
    let portable_candidates = [
        comfy_path
            .parent()
            .map(|p| p.join("python_embeded").join("Lib").join("site-packages").join("torch")),
        Some(comfy_path.join("python_embeded").join("Lib").join("site-packages").join("torch")),
    ];
    for c in portable_candidates.into_iter().flatten() {
        if c.exists() {
            return true;
        }
    }

    // Path 2: system Python — derive its prefix from the resolved path
    // and look for torch in the standard sysconfig location. This catches
    // the from-source case where pip dropped torch into the system
    // Python's site-packages.
    let candidate_pythons = collect_candidate_pythons();
    for py in candidate_pythons {
        if let Some(prefix) = Path::new(&py).parent() {
            // Windows layout: <prefix>/Lib/site-packages
            let win_torch = prefix.join("Lib").join("site-packages").join("torch");
            if win_torch.exists() {
                return true;
            }
            // Unix layout: <prefix>/../lib/python3.X/site-packages — be
            // permissive, just look for any torch under <prefix>/../lib.
            if let Some(parent) = prefix.parent() {
                let lib = parent.join("lib");
                if lib.exists() {
                    if let Ok(entries) = std::fs::read_dir(&lib) {
                        for e in entries.flatten() {
                            if e.path().join("site-packages").join("torch").exists() {
                                return true;
                            }
                        }
                    }
                }
            }
        }
    }

    false
}

/// Collect the system Python paths we might want to probe. Mirrors the
/// search order in `python::get_python_bin` but returns *all* hits, not
/// just the first — so the carcass check works even when the user has
/// torch installed in a non-default Python.
fn collect_candidate_pythons() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    if !cfg!(target_os = "windows") {
        for bin in &["python3", "python"] {
            out.push(bin.to_string());
        }
        return out;
    }

    // `where python` candidates (excluding WindowsApps stub).
    let mut where_cmd = Command::new("where");
    where_cmd.arg("python");
    #[cfg(target_os = "windows")]
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = where_cmd.output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let path = line.trim();
                if !path.is_empty() && !path.contains("WindowsApps") {
                    out.push(path.to_string());
                }
            }
        }
    }

    for p in [
        "C:\\Python313\\python.exe",
        "C:\\Python312\\python.exe",
        "C:\\Python311\\python.exe",
        "C:\\Python310\\python.exe",
        "C:\\Python39\\python.exe",
    ] {
        if Path::new(p).exists() {
            out.push(p.to_string());
        }
    }

    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let programs = Path::new(&localappdata).join("Programs").join("Python");
        if let Ok(entries) = std::fs::read_dir(&programs) {
            for e in entries.flatten() {
                let py = e.path().join("python.exe");
                if py.exists() {
                    out.push(py.to_string_lossy().to_string());
                }
            }
        }
    }

    out
}

pub fn find_comfyui_path() -> Option<String> {
    // 1. Check environment variable
    if let Ok(env_path) = std::env::var("COMFYUI_PATH") {
        if Path::new(&env_path).join("main.py").exists() {
            return Some(env_path);
        }
    }

    // 2. Read from app config
    if let Some(config_dir) = dirs::config_dir() {
        let config_file = config_dir.join("locally-uncensored").join("config.json");
        if config_file.exists() {
            if let Ok(content) = fs::read_to_string(&config_file) {
                if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(path) = config.get("comfyui_path").and_then(|v| v.as_str()) {
                        if Path::new(path).join("main.py").exists() {
                            return Some(path.to_string());
                        }
                    }
                }
            }
        }
    }

    // 2b. Deep scan user home directory (finds ComfyUI in non-standard paths like Desktop/bs/IMage Gen/ComfyUI)
    let home2 = dirs::home_dir().unwrap_or_default();
    if let Some(found) = scan_for_comfyui(&home2, 7) {
        println!("[ComfyUI] Found via deep home scan: {}", found.display());
        return Some(found.to_string_lossy().to_string());
    }

    let home = dirs::home_dir().unwrap_or_default();

    // 3. Check common fixed locations (including Stability Matrix, portable installs)
    let mut fixed: Vec<PathBuf> = vec![
        home.join("ComfyUI"),
        home.join("Desktop").join("ComfyUI"),
        home.join("Documents").join("ComfyUI"),
        PathBuf::from("C:\\ComfyUI"),
        PathBuf::from("D:\\ComfyUI"),
    ];

    if cfg!(target_os = "windows") {
        // Stability Matrix stores ComfyUI in AppData
        if let Ok(appdata) = std::env::var("APPDATA") {
            fixed.push(PathBuf::from(&appdata).join("StabilityMatrix").join("Packages").join("ComfyUI"));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            fixed.push(PathBuf::from(&localappdata).join("StabilityMatrix").join("Packages").join("ComfyUI"));
        }
        // Common Program Files locations
        fixed.push(PathBuf::from("C:\\Program Files\\ComfyUI"));
        fixed.push(PathBuf::from("C:\\AI\\ComfyUI"));
        fixed.push(PathBuf::from("D:\\AI\\ComfyUI"));
    }

    for p in &fixed {
        if p.join("main.py").exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }

    // 4. Recursive scan of Desktop, Documents, Downloads, and drive roots
    let mut scan_roots: Vec<PathBuf> = vec![
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Downloads"),
    ];
    if cfg!(target_os = "windows") {
        scan_roots.push(PathBuf::from("C:\\"));
        scan_roots.push(PathBuf::from("D:\\"));
        scan_roots.push(PathBuf::from("E:\\"));
    } else {
        scan_roots.push(PathBuf::from("/opt"));
        scan_roots.push(PathBuf::from("/usr/local"));
    }

    for root in &scan_roots {
        if root.exists() {
            if let Some(found) = scan_for_comfyui(root, 5) {
                return Some(found.to_string_lossy().to_string());
            }
        }
    }

    None
}

fn is_comfyui_running_on_port(port: u16) -> bool {
    reqwest::blocking::get(format!("http://localhost:{}/system_stats", port))
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn start_ollama(_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Check if already running
    {
        let mut cmd = Command::new("tasklist");
        cmd.args(["/FI", "IMAGENAME eq ollama.exe"]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = cmd.output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("ollama.exe") {
                println!("[Ollama] Already running");
                return Ok(serde_json::json!({"status": "already_running"}));
            }
        }
    }

    println!("[Ollama] Starting...");
    let mut cmd = Command::new("ollama");
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let result = cmd.spawn();

    match result {
        Ok(_) => {
            println!("[Ollama] Started");
            Ok(serde_json::json!({"status": "started"}))
        }
        Err(e) => {
            println!("[Ollama] Failed to start: {}", e);
            Ok(serde_json::json!({"status": "error", "error": e.to_string()}))
        }
    }
}

#[tauri::command]
pub fn start_comfyui(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // If user pointed LU at a remote ComfyUI, we have no local process to spawn.
    // Just report status — the remote side is responsible for running ComfyUI.
    {
        let host = state.comfy_host.lock().unwrap().clone();
        if !is_local_host(&host) {
            return Ok(serde_json::json!({
                "status": "remote",
                "host": host,
                "message": "Remote ComfyUI — manage the Python process on the server itself"
            }));
        }
    }

    let port = *state.comfy_port.lock().unwrap();

    if is_comfyui_running_on_port(port) {
        return Ok(serde_json::json!({"status": "already_running"}));
    }

    let comfy_path = {
        let path = state.comfy_path.lock().unwrap();
        path.clone()
    };

    let comfy_path = comfy_path
        .or_else(|| find_comfyui_path())
        .ok_or_else(|| "ComfyUI not found".to_string())?;

    // Store the path for future use
    {
        let mut path = state.comfy_path.lock().unwrap();
        *path = Some(comfy_path.clone());
    }

    // Prefer the portable's bundled Python over the system one. ComfyUI
    // Portable (NVIDIA, AMD, CPU variants) ships its own Python with the
    // matching torch wheel pre-installed — using the system Python instead
    // wastes that and on AMD it actively fails because system Python lacks
    // the DirectML / ROCm bindings the portable installer prepared. Layout:
    //   <ComfyUI>/python_embeded/python.exe   ← what we want
    //   <ComfyUI>/main.py
    // Fixed Discord report from reload__: AMD Portable launchte nicht.
    let portable_python = std::path::Path::new(&comfy_path)
        .parent()
        .and_then(|p| {
            let candidate = p.join("python_embeded").join("python.exe");
            if candidate.exists() { Some(candidate.to_string_lossy().to_string()) } else { None }
        });
    let bundled_python = portable_python.or_else(|| {
        // Some portable variants nest python_embeded inside the ComfyUI dir
        // itself rather than alongside it.
        let candidate = std::path::Path::new(&comfy_path).join("python_embeded").join("python.exe");
        if candidate.exists() { Some(candidate.to_string_lossy().to_string()) } else { None }
    });
    let system_python = state.python_bin.lock().unwrap().clone();
    let python = bundled_python.clone().unwrap_or(system_python.clone());
    let port_str = port.to_string();
    if python.is_empty() {
        return Err(
            "No Python available — install Python first (Settings → ComfyUI → Install Python). \
             ComfyUI from-source needs a system Python; install one and retry."
                .to_string(),
        );
    }
    if bundled_python.is_some() {
        println!("[ComfyUI] Using bundled portable Python: {}", python);
    } else {
        println!("[ComfyUI] Using system Python: {}", python);
    }
    println!("[ComfyUI] Starting from: {} on port {}", comfy_path, port);

    let mut cmd = Command::new(&python);
    cmd.args(["main.py", "--listen", "127.0.0.1", "--port", &port_str, "--enable-cors-header", "*"])
        .current_dir(&comfy_path)
        .env("TQDM_DISABLE", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start ComfyUI (python={}): {}", python, e))?;

    // Assign to Job Object so child dies when parent dies (even via Task Manager)
    #[cfg(target_os = "windows")]
    assign_to_kill_on_close_job(&child);

    // Drain stdout/stderr in background threads to prevent buffer deadlock
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("[ComfyUI] {}", line);
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("[ComfyUI] {}", line);
                }
            }
        });
    }

    // Store process
    {
        let mut proc = state.comfy_process.lock().unwrap();
        *proc = Some(child);
    }

    println!("[ComfyUI] Started");
    Ok(serde_json::json!({"status": "started", "path": comfy_path}))
}

#[tauri::command]
pub fn stop_comfyui(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut proc = state.comfy_process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        let pid = child.id();
        if cfg!(target_os = "windows") {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output();
        } else {
            let _ = child.kill();
        }
        *proc = None;
        println!("[ComfyUI] Stopped");
        Ok(serde_json::json!({"status": "stopped"}))
    } else {
        Ok(serde_json::json!({"status": "not_running"}))
    }
}

#[tauri::command]
pub async fn comfyui_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let port = *state.comfy_port.lock().unwrap();
    let host = state.comfy_host.lock().unwrap().clone();
    let is_local = is_local_host(&host);

    // Probe the configured host (not just localhost). Remote ComfyUI
    // still reports running: true if the /system_stats endpoint responds.
    let running = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()
        .and_then(|c| Some(c.get(format!("http://{}:{}/system_stats", host, port))))
        .map(|req| async move { req.send().await.map(|r| r.status().is_success()).unwrap_or(false) })
    ;
    let running = match running {
        Some(fut) => fut.await,
        None => false,
    };

    let process_alive = {
        let proc = state.comfy_process.lock().unwrap();
        proc.is_some()
    };

    let path = {
        let p = state.comfy_path.lock().unwrap();
        p.clone()
    };

    // For remote hosts we don't care whether a local install path exists.
    let resolved_path: Option<String> = if is_local {
        path.clone().or_else(find_comfyui_path)
    } else {
        None
    };

    let found = if is_local {
        resolved_path.is_some()
    } else {
        true  // the remote side handles its own install
    };

    // Carcass detection: a local install is only "complete" if torch is
    // actually reachable. Remote hosts are reported complete by definition
    // — the remote side owns its own install state.
    let complete = if is_local {
        match &resolved_path {
            Some(p) => is_comfyui_install_complete(Path::new(p)),
            None => false,
        }
    } else {
        true
    };

    Ok(serde_json::json!({
        "running": running,
        "starting": process_alive && !running,
        "found": found,
        "complete": complete,
        "path": path,
        "port": port,
        "host": host,
        "isLocal": is_local,
        "processAlive": process_alive,
    }))
}

/// Returns true when `host` refers to the local machine.
/// Anything else = remote and LU won't try to manage the process.
pub fn is_local_host(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0" | "")
}

#[tauri::command]
pub fn find_comfyui() -> Result<serde_json::Value, String> {
    match find_comfyui_path() {
        Some(path) => {
            // Surface install completeness so the UI can distinguish a
            // working ComfyUI from a half-cloned carcass and offer the
            // right action (Continue vs. Re-install). See
            // is_comfyui_install_complete for the definition of "complete".
            let complete = is_comfyui_install_complete(Path::new(&path));
            Ok(serde_json::json!({
                "found": true,
                "path": path,
                "complete": complete,
            }))
        }
        None => Ok(serde_json::json!({
            "found": false,
            "path": null,
            "complete": false,
        })),
    }
}

#[tauri::command]
pub fn set_comfyui_path(path: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let main_py = Path::new(&path).join("main.py");
    if !main_py.exists() {
        return Err(format!("main.py not found in {}", path));
    }

    // Store in memory
    {
        let mut p = state.comfy_path.lock().unwrap();
        *p = Some(path.clone());
    }

    // Persist to config file
    if let Some(config_dir) = dirs::config_dir() {
        let app_config = config_dir.join("locally-uncensored");
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["comfyui_path"] = serde_json::json!(path);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    Ok(serde_json::json!({"status": "saved", "path": path}))
}

#[tauri::command]
pub fn set_comfyui_host(host: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("Host must not be empty".to_string());
    }
    // Reject obviously invalid chars — helps avoid URL-injection style typos.
    if trimmed.contains('/') || trimmed.contains(' ') || trimmed.contains('?') {
        return Err("Host must be a plain hostname or IP, no slashes/spaces".to_string());
    }
    let final_host = trimmed.to_string();

    {
        let mut h = state.comfy_host.lock().unwrap();
        *h = final_host.clone();
    }

    // Persist to config file
    if let Some(config_dir) = dirs::config_dir() {
        let app_config = config_dir.join("locally-uncensored");
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["comfyui_host"] = serde_json::json!(final_host);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    let is_local = is_local_host(&final_host);
    println!("[ComfyUI] Host set to {} (local={})", final_host, is_local);
    Ok(serde_json::json!({"status": "saved", "host": final_host, "isLocal": is_local}))
}

#[tauri::command]
pub fn set_comfyui_port(port: u16, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    if port == 0 {
        return Err("Port must be greater than 0".to_string());
    }

    {
        let mut p = state.comfy_port.lock().unwrap();
        *p = port;
    }

    // Persist to config file
    if let Some(config_dir) = dirs::config_dir() {
        let app_config = config_dir.join("locally-uncensored");
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["comfyui_port"] = serde_json::json!(port);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    println!("[ComfyUI] Port set to {}", port);
    Ok(serde_json::json!({"status": "saved", "port": port}))
}

/// Normalize user input into a full Ollama base URL.
/// Accepts bare `host:port`, scheme-less host, or full URL.
/// Returns full URL without trailing slash, or Err for obviously bad input.
fn normalize_ollama_base(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Endpoint must not be empty".into());
    }
    // Reject whitespace / newlines inside the URL.
    if trimmed.chars().any(|c| c.is_whitespace()) {
        return Err("Endpoint must not contain whitespace".into());
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    };
    // Sanity-check with a URL parse so "http://" alone or "http://:1234" can't pass.
    match url::Url::parse(&with_scheme) {
        Ok(u) if u.host_str().map_or(false, |h| !h.is_empty()) => Ok(with_scheme),
        _ => Err(format!("Not a valid URL: {}", input)),
    }
}

#[tauri::command]
pub fn set_ollama_host(host: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let final_base = normalize_ollama_base(&host)?;

    {
        let mut b = state.ollama_base.lock().unwrap();
        *b = final_base.clone();
    }

    // Persist to config file under ollama_base — next startup will pick it
    // up via load_ollama_base() before any request fires.
    if let Some(config_dir) = dirs::config_dir() {
        let app_config = config_dir.join("locally-uncensored");
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["ollama_base"] = serde_json::json!(final_base);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    let is_local = url::Url::parse(&final_base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .map(|h| matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0"))
        .unwrap_or(false);

    println!("[Ollama] Base URL set to {} (local={})", final_base, is_local);
    Ok(serde_json::json!({"status": "saved", "base": final_base, "isLocal": is_local}))
}

#[tauri::command]
pub fn get_ollama_host(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let base = state.ollama_base.lock().unwrap().clone();
    let is_local = url::Url::parse(&base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .map(|h| matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0"))
        .unwrap_or(false);
    Ok(serde_json::json!({"base": base, "isLocal": is_local}))
}

/// Auto-start Ollama on app launch (called from setup)
pub fn auto_start_ollama(_state: &AppState) {
    // Check if already running
    {
        let mut cmd = Command::new("tasklist");
        cmd.args(["/FI", "IMAGENAME eq ollama.exe"]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = cmd.output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("ollama.exe") {
                println!("[Ollama] Already running");
                return;
            }
        }
    }

    println!("[Ollama] Starting...");
    let mut cmd = Command::new("ollama");
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.spawn() {
        Ok(_) => println!("[Ollama] Started"),
        Err(e) => println!("[Ollama] Failed to start: {}", e),
    }
}

/// Auto-start ComfyUI on app launch (called from setup)
pub fn auto_start_comfyui(state: &AppState) {
    // If user configured a remote host, don't try to auto-start anything locally.
    {
        let host = state.comfy_host.lock().unwrap().clone();
        if !is_local_host(&host) {
            println!("[ComfyUI] Remote host configured ({}), skipping local auto-start", host);
            return;
        }
    }

    // Always try to find and store the ComfyUI path (needed for downloads)
    if state.comfy_path.lock().unwrap().is_none() {
        if let Some(path) = find_comfyui_path() {
            println!("[ComfyUI] Found at: {}", path);
            *state.comfy_path.lock().unwrap() = Some(path);
        }
    }

    let port = *state.comfy_port.lock().unwrap();

    if is_comfyui_running_on_port(port) {
        println!("[ComfyUI] Already running on port {}", port);
        return;
    }

    match find_comfyui_path() {
        Some(path) => {
            let port_str = port.to_string();
            println!("[ComfyUI] Auto-starting from: {} on port {}", path, port);
            *state.comfy_path.lock().unwrap() = Some(path.clone());

            // Mirror the start_comfyui Python preference: use the portable's
            // bundled Python when present so AMD / cu126 / CPU portables boot
            // with the right torch wheel. See start_comfyui for full context.
            let portable_python = std::path::Path::new(&path)
                .parent()
                .and_then(|p| {
                    let c = p.join("python_embeded").join("python.exe");
                    if c.exists() { Some(c.to_string_lossy().to_string()) } else { None }
                })
                .or_else(|| {
                    let c = std::path::Path::new(&path).join("python_embeded").join("python.exe");
                    if c.exists() { Some(c.to_string_lossy().to_string()) } else { None }
                });
            let system_python = state.python_bin.lock().unwrap().clone();
            let python = portable_python.clone().unwrap_or_else(|| system_python.clone());
            if python.is_empty() {
                println!("[ComfyUI] Auto-start skipped: no Python available (install via P14 flow)");
                return;
            }
            if portable_python.is_some() {
                println!("[ComfyUI] Auto-start using bundled portable Python: {}", python);
            }

            let mut cmd = Command::new(&python);
            cmd.args(["main.py", "--listen", "127.0.0.1", "--port", &port_str, "--enable-cors-header", "*"])
                .current_dir(&path)
                .env("TQDM_DISABLE", "1")
                .env("PYTHONUNBUFFERED", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            match cmd.spawn() {
                Ok(mut child) => {
                    // Assign to Job Object so child dies when parent dies (even via Task Manager)
                    #[cfg(target_os = "windows")]
                    assign_to_kill_on_close_job(&child);

                    // Drain stdout/stderr in background threads to prevent buffer deadlock
                    if let Some(stdout) = child.stdout.take() {
                        std::thread::spawn(move || {
                            use std::io::{BufRead, BufReader};
                            let reader = BufReader::new(stdout);
                            for line in reader.lines() {
                                if let Ok(line) = line {
                                    println!("[ComfyUI] {}", line);
                                }
                            }
                        });
                    }
                    if let Some(stderr) = child.stderr.take() {
                        std::thread::spawn(move || {
                            use std::io::{BufRead, BufReader};
                            let reader = BufReader::new(stderr);
                            for line in reader.lines() {
                                if let Ok(line) = line {
                                    println!("[ComfyUI] {}", line);
                                }
                            }
                        });
                    }

                    *state.comfy_process.lock().unwrap() = Some(child);
                    println!("[ComfyUI] Started");
                }
                Err(e) => println!("[ComfyUI] Failed to start: {}", e),
            }
        }
        None => println!("[ComfyUI] Not found. Install ComfyUI or set path in settings."),
    }
}
