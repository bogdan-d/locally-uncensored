// B7 — system_health Tauri command. Returns a structured probe of every
// local backend LU cares about plus a couple of host facts, so the
// Settings → Troubleshoot panel can render an "everything in one
// glance" diagnostic. Each probe is bounded by a short HTTP timeout and
// classified into one of `ok` / `unreachable` / `not_installed` /
// `error` so the UI can colour-code without re-parsing strings.
//
// This is intentionally a one-shot synchronous probe (300 ms per
// backend, ~1 s total worst case) — Settings opens infrequently and a
// long-lived background poll would be more code for less value. The
// v2.4.5 "60s actionable ComfyUI panel" stays where it is; this is the
// broader picture.

use crate::state::AppState;
use serde::Serialize;
use std::time::Duration;
use sysinfo::{Disks, System};
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // NotInstalled reserved for future "binary not on PATH" probes
pub enum ProbeStatus {
    Ok,
    Unreachable,
    NotInstalled,
    Error,
}

#[derive(Debug, Serialize)]
pub struct BackendProbe {
    pub status: ProbeStatus,
    /// Free-form detail (HTTP status code, error string head). Empty when ok.
    pub detail: String,
    /// Endpoint that was probed. Useful for the "wait, was I looking at
    /// the wrong port?" debugging case.
    pub endpoint: String,
}

#[derive(Debug, Serialize)]
pub struct HostFacts {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_count: u32,
    /// Total physical memory, in GB rounded to 1 decimal.
    pub ram_gb: f64,
    /// Free disk space on the LU install drive, in GB.
    pub disk_free_gb: f64,
}

#[derive(Debug, Serialize)]
pub struct SystemHealthReport {
    pub version: String,
    pub host: HostFacts,
    pub ollama: BackendProbe,
    pub comfyui: BackendProbe,
    pub lm_studio: BackendProbe,
}

fn probe_http(url: &str) -> BackendProbe {
    let endpoint = url.to_string();
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(300))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return BackendProbe {
                status: ProbeStatus::Error,
                detail: format!("client build failed: {}", e),
                endpoint,
            };
        }
    };
    match client.get(url).send() {
        Ok(resp) => {
            let code = resp.status();
            if code.is_success() {
                BackendProbe { status: ProbeStatus::Ok, detail: String::new(), endpoint }
            } else {
                BackendProbe {
                    status: ProbeStatus::Error,
                    detail: format!("HTTP {}", code.as_u16()),
                    endpoint,
                }
            }
        }
        Err(e) => {
            // Connection-refused is the dominant "backend not running"
            // case — we classify it as `unreachable` instead of `error`
            // so the UI can render a friendlier hint.
            let msg = e.to_string();
            let head = msg.chars().take(160).collect::<String>();
            if msg.contains("Connection refused") || msg.contains("ConnectFailed") {
                BackendProbe { status: ProbeStatus::Unreachable, detail: head, endpoint }
            } else {
                BackendProbe { status: ProbeStatus::Error, detail: head, endpoint }
            }
        }
    }
}

fn collect_host_facts() -> HostFacts {
    let mut sys = System::new_all();
    sys.refresh_memory();
    let total_kb = sys.total_memory(); // bytes in sysinfo 0.33
    let ram_gb = (total_kb as f64) / 1_073_741_824.0;
    let cpu_count = num_cpus::get() as u32;
    let os = std::env::consts::OS.to_string();
    let os_version = System::os_version().unwrap_or_else(|| "unknown".to_string());
    let arch = std::env::consts::ARCH.to_string();
    // Free space on the drive that holds $HOME (or the closest mount
    // point sysinfo reports for it). Covers the "is the model dir
    // running out?" question without needing a separate probe.
    let disk_free_gb = {
        let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        let disks = Disks::new_with_refreshed_list();
        // Pick the longest mount-point prefix that matches HOME — that's
        // the drive HOME actually lives on (vs. some unrelated drive
        // sysinfo also enumerated).
        let mut best: Option<(usize, u64)> = None;
        for disk in disks.list() {
            let mp = disk.mount_point();
            if let Some(s) = mp.to_str() {
                if home.starts_with(s) {
                    let len = s.len();
                    if best.map(|(b, _)| len > b).unwrap_or(true) {
                        best = Some((len, disk.available_space()));
                    }
                }
            }
        }
        let bytes = best.map(|(_, b)| b).unwrap_or(0);
        (bytes as f64) / 1_073_741_824.0
    };
    HostFacts {
        os,
        os_version,
        arch,
        cpu_count,
        ram_gb: (ram_gb * 10.0).round() / 10.0,
        disk_free_gb: (disk_free_gb * 10.0).round() / 10.0,
    }
}

#[tauri::command]
pub async fn system_health(_state: State<'_, AppState>) -> Result<SystemHealthReport, String> {
    // All three probes are tiny — run them serially to keep error
    // handling readable. Total worst case is 3 × 300 ms = 900 ms.
    let ollama = probe_http("http://127.0.0.1:11434/api/tags");
    let comfyui = probe_http("http://127.0.0.1:8188/system_stats");
    let lm_studio = probe_http("http://127.0.0.1:1234/v1/models");

    Ok(SystemHealthReport {
        version: env!("CARGO_PKG_VERSION").to_string(),
        host: collect_host_facts(),
        ollama,
        comfyui,
        lm_studio,
    })
}
