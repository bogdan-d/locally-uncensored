use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Compute the path to the venv's Python interpreter for a ComfyUI install
/// at `comfyui_dir`. Layout matches what `python -m venv` produces.
///
/// * Windows: `<comfyui_dir>/venv/Scripts/python.exe`
/// * Unix:    `<comfyui_dir>/venv/bin/python`
///
/// The file is NOT guaranteed to exist — call `path.exists()` if you care.
/// Used by both the installer (Bug E — PEP 668 venv creation) and the
/// process launcher (so `start_comfyui` runs ComfyUI inside the same
/// isolated env that pip installed PyTorch into).
pub fn venv_python_path(comfyui_dir: &Path) -> PathBuf {
    venv_python_path_named(comfyui_dir, "venv")
}

/// Same as [`venv_python_path`] but for an arbitrary venv directory name.
/// ComfyUI installs in the wild use either the classic `venv` (LU's own
/// PEP 668 installer — Bug E) or the modern `.venv` (`uv`,
/// `python -m venv .venv`). The file is NOT guaranteed to exist.
pub fn venv_python_path_named(comfyui_dir: &Path, venv_name: &str) -> PathBuf {
    let venv = comfyui_dir.join(venv_name);
    if cfg!(target_os = "windows") {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// Resolve the venv Python for `comfyui_dir` iff it exists. Returns the
/// path as a String (matching the API that `process::start_comfyui` already
/// uses for its `bundled_python` / `system_python` slots), or None when
/// no venv has been created — caller falls back to the system Python.
///
/// Checks both the classic `venv` and the modern `.venv` directory (issue #51,
/// adhney): a macOS/Linux ComfyUI installed into `.venv` was previously missed,
/// so `start_comfyui` fell back to the system Python and crashed with
/// `ModuleNotFoundError: torch`. `venv` is checked first to preserve the exact
/// behavior for users whose env LU's own installer created.
pub fn resolve_comfyui_venv_python(comfyui_dir: &Path) -> Option<String> {
    for venv_name in ["venv", ".venv"] {
        let candidate = venv_python_path_named(comfyui_dir, venv_name);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// Resolve the real Python binary path, filtering out the Microsoft Store stub
/// alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`) which prints
/// "Python was not found, run without arguments to install from the Microsoft
/// Store" and exits 1 — useless for `pip install`. Returns the empty string
/// when no real Python is available; callers must treat `""` as
/// "Python not installed". Falling back to the bare `"python"` string the way
/// older versions did re-introduces the Store-stub trap on a fresh Windows
/// box, which is exactly the bug P14 fixes.
pub fn get_python_bin() -> String {
    if cfg!(not(target_os = "windows")) {
        // On Linux/macOS, try python3 first, then python
        for bin in &["python3", "python"] {
            if let Ok(output) = Command::new(bin).arg("--version").output() {
                if output.status.success() {
                    return bin.to_string();
                }
            }
        }
        // Nothing usable — empty string sentinel.
        return String::new();
    }

    // Windows: use `where python` and filter out WindowsApps alias
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
                    // Verify it actually runs
                    let mut check_cmd = Command::new(path);
                    check_cmd.arg("--version");
                    #[cfg(target_os = "windows")]
                    check_cmd.creation_flags(CREATE_NO_WINDOW);
                    if let Ok(check) = check_cmd.output() {
                        if check.status.success() {
                            println!("[Python] Found via `where`: {}", path);
                            return path.to_string();
                        }
                    }
                }
            }
        }
    }

    // Check common Windows Python install locations
    let common_paths = [
        // Standard Python.org installers
        "C:\\Python313\\python.exe",
        "C:\\Python312\\python.exe",
        "C:\\Python311\\python.exe",
        "C:\\Python310\\python.exe",
        "C:\\Python39\\python.exe",
    ];

    for p in &common_paths {
        if Path::new(p).exists() {
            println!("[Python] Found at fixed path: {}", p);
            return p.to_string();
        }
    }

    // Check user-local Python (AppData\Local\Programs\Python)
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let programs_python = Path::new(&localappdata).join("Programs").join("Python");
        if programs_python.exists() {
            // Scan for Python3xx directories, newest first
            if let Ok(entries) = std::fs::read_dir(&programs_python) {
                let mut dirs: Vec<_> = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().ok().map_or(false, |ft| ft.is_dir()))
                    .collect();
                dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

                for dir in dirs {
                    let python_exe = dir.path().join("python.exe");
                    if python_exe.exists() {
                        let path = python_exe.to_string_lossy().to_string();
                        println!("[Python] Found in AppData: {}", path);
                        return path;
                    }
                }
            }
        }
    }

    // Check Conda environments
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let conda_paths = [
            Path::new(&userprofile).join("miniconda3").join("python.exe"),
            Path::new(&userprofile).join("anaconda3").join("python.exe"),
            Path::new(&userprofile).join("miniconda3").join("Scripts").join("python.exe"),
            Path::new(&userprofile).join("anaconda3").join("Scripts").join("python.exe"),
        ];
        for p in &conda_paths {
            if p.exists() {
                let path = p.to_string_lossy().to_string();
                println!("[Python] Found Conda: {}", path);
                return path;
            }
        }
    }

    println!("[Python] No real Python found on PATH or known locations — returning empty sentinel");
    String::new()
}

/// True iff `bin` looks like a real, runnable Python binary (not the empty
/// sentinel from `get_python_bin` and not a Microsoft Store stub).
pub fn is_real_python(bin: &str) -> bool {
    if bin.is_empty() {
        return false;
    }
    if bin.contains("WindowsApps") {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ── venv_python_path layout (Bug E — Arch PEP 668 venv) ─────────────────

    #[test]
    fn venv_python_path_matches_platform_layout() {
        let p = venv_python_path(Path::new("/home/u/ComfyUI"));
        let s = p.to_string_lossy().to_string();
        // On Windows expect `Scripts/python.exe`, on Unix expect `bin/python`.
        if cfg!(target_os = "windows") {
            assert!(
                s.ends_with("venv\\Scripts\\python.exe") || s.ends_with("venv/Scripts/python.exe"),
                "got {} on Windows",
                s
            );
        } else {
            assert!(s.ends_with("venv/bin/python"), "got {} on Unix", s);
        }
    }

    #[test]
    fn venv_python_path_is_under_comfyui_dir() {
        let comfy = Path::new("/some/where/ComfyUI");
        let venv_py = venv_python_path(comfy);
        assert!(
            venv_py.starts_with(comfy),
            "venv python {} did not start with {}",
            venv_py.display(),
            comfy.display()
        );
    }

    // ── resolve_comfyui_venv_python — existence gate ────────────────────────

    #[test]
    fn resolve_returns_none_when_venv_missing() {
        let tmp = std::env::temp_dir().join("lu-venv-test-missing");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        assert!(resolve_comfyui_venv_python(&tmp).is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_returns_some_when_venv_python_exists() {
        // Build the exact layout `python -m venv` would produce so the
        // resolver finds it without actually invoking Python.
        let tmp = std::env::temp_dir().join("lu-venv-test-present");
        let _ = fs::remove_dir_all(&tmp);
        let inner = if cfg!(target_os = "windows") {
            tmp.join("venv").join("Scripts")
        } else {
            tmp.join("venv").join("bin")
        };
        fs::create_dir_all(&inner).unwrap();
        let py = if cfg!(target_os = "windows") {
            inner.join("python.exe")
        } else {
            inner.join("python")
        };
        fs::write(&py, "stub").unwrap();
        let resolved = resolve_comfyui_venv_python(&tmp);
        assert!(resolved.is_some(), "expected resolver to find {}", py.display());
        assert!(resolved.unwrap().contains("venv"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_finds_dot_venv_layout() {
        // Issue #51 (adhney): ComfyUI installed into `.venv` (uv / modern
        // `python -m venv .venv`) must also be picked up, not just `venv`.
        let tmp = std::env::temp_dir().join("lu-dotvenv-test-present");
        let _ = fs::remove_dir_all(&tmp);
        let inner = if cfg!(target_os = "windows") {
            tmp.join(".venv").join("Scripts")
        } else {
            tmp.join(".venv").join("bin")
        };
        fs::create_dir_all(&inner).unwrap();
        let py = if cfg!(target_os = "windows") {
            inner.join("python.exe")
        } else {
            inner.join("python")
        };
        fs::write(&py, "stub").unwrap();
        let resolved = resolve_comfyui_venv_python(&tmp);
        assert!(resolved.is_some(), "expected resolver to find {}", py.display());
        assert!(resolved.unwrap().contains(".venv"));
        let _ = fs::remove_dir_all(&tmp);
    }

    // ── is_real_python (Bug P14 — Microsoft Store stub filter) ──────────────

    #[test]
    fn real_python_rejects_empty() {
        assert!(!is_real_python(""));
    }

    #[test]
    fn real_python_rejects_windowsapps_stub() {
        assert!(!is_real_python("C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"));
    }

    #[test]
    fn real_python_accepts_real_path() {
        assert!(is_real_python("/usr/bin/python3"));
        assert!(is_real_python("C:\\Python312\\python.exe"));
    }
}
