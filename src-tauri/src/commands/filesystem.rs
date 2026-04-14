use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine;
use glob::glob as glob_match;
use regex::Regex;
use walkdir::WalkDir;

/// Resolve path — supports absolute and relative (relative to home/agent-workspace)
fn resolve_path(path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        dirs::home_dir()
            .unwrap_or_default()
            .join("agent-workspace")
            .join(path)
    }
}

fn file_meta(path: &Path) -> serde_json::Value {
    let meta = fs::metadata(path);
    let (size, modified, is_dir) = match meta {
        Ok(m) => (
            m.len(),
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            m.is_dir(),
        ),
        Err(_) => (0, 0, false),
    };
    serde_json::json!({
        "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "path": path.to_string_lossy(),
        "size": size,
        "isDir": is_dir,
        "modified": modified,
    })
}

#[tauri::command]
pub fn fs_read(path: String) -> Result<serde_json::Value, String> {
    let full = resolve_path(&path);
    if !full.exists() {
        return Err(format!("File not found: {}", full.display()));
    }

    // Try text first, fall back to base64 for binary
    match fs::read_to_string(&full) {
        Ok(content) => Ok(serde_json::json!({ "content": content, "encoding": "utf8" })),
        Err(_) => {
            let bytes = fs::read(&full).map_err(|e| format!("Read error: {}", e))?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(serde_json::json!({ "content": b64, "encoding": "base64" }))
        }
    }
}

#[tauri::command]
pub fn fs_write(path: String, content: String) -> Result<serde_json::Value, String> {
    let full = resolve_path(&path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create dir: {}", e))?;
    }
    fs::write(&full, &content).map_err(|e| format!("Write error: {}", e))?;
    Ok(serde_json::json!({ "status": "saved", "path": full.to_string_lossy() }))
}

#[tauri::command]
pub fn fs_list(
    path: String,
    recursive: Option<bool>,
    pattern: Option<String>,
) -> Result<serde_json::Value, String> {
    let dir = resolve_path(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    let mut entries: Vec<serde_json::Value> = Vec::new();
    let max_entries = 500;

    if let Some(ref pat) = pattern {
        // Glob pattern relative to dir
        let glob_pattern = dir.join(pat).to_string_lossy().to_string();
        if let Ok(paths) = glob_match(&glob_pattern) {
            for entry in paths.flatten() {
                if entries.len() >= max_entries {
                    break;
                }
                entries.push(file_meta(&entry));
            }
        }
    } else if recursive.unwrap_or(false) {
        for entry in WalkDir::new(&dir).max_depth(5).into_iter().filter_map(|e| e.ok()) {
            if entries.len() >= max_entries {
                break;
            }
            entries.push(file_meta(entry.path()));
        }
    } else {
        let read_dir = fs::read_dir(&dir).map_err(|e| format!("Read dir: {}", e))?;
        for entry in read_dir.flatten() {
            if entries.len() >= max_entries {
                break;
            }
            entries.push(file_meta(&entry.path()));
        }
    }

    Ok(serde_json::json!({ "entries": entries, "count": entries.len() }))
}

#[tauri::command]
pub fn fs_search(
    path: String,
    pattern: String,
    max_results: Option<u32>,
) -> Result<serde_json::Value, String> {
    let dir = resolve_path(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    let re = Regex::new(&pattern).map_err(|e| format!("Invalid regex: {}", e))?;
    let max = max_results.unwrap_or(50) as usize;
    let mut results: Vec<serde_json::Value> = Vec::new();

    for entry in WalkDir::new(&dir).max_depth(8).into_iter().filter_map(|e| e.ok()) {
        if results.len() >= max {
            break;
        }
        let p = entry.path();
        if !p.is_file() {
            continue;
        }

        // Skip binary / large files
        let meta = fs::metadata(p);
        if let Ok(m) = &meta {
            if m.len() > 1_000_000 {
                continue;
            }
        }

        if let Ok(content) = fs::read_to_string(p) {
            let mut matches: Vec<serde_json::Value> = Vec::new();
            for (line_num, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    matches.push(serde_json::json!({
                        "line": line_num + 1,
                        "text": if line.len() > 200 { &line[..200] } else { line },
                    }));
                    if matches.len() >= 10 {
                        break;
                    }
                }
            }
            if !matches.is_empty() {
                results.push(serde_json::json!({
                    "file": p.to_string_lossy(),
                    "matches": matches,
                }));
            }
        }
    }

    Ok(serde_json::json!({ "results": results, "count": results.len() }))
}

#[tauri::command]
pub fn fs_info(path: String) -> Result<serde_json::Value, String> {
    let full = resolve_path(&path);
    if !full.exists() {
        return Err(format!("Path not found: {}", full.display()));
    }
    let meta = fs::metadata(&full).map_err(|e| format!("Metadata error: {}", e))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(serde_json::json!({
        "path": full.to_string_lossy(),
        "size": meta.len(),
        "isDir": meta.is_dir(),
        "isFile": meta.is_file(),
        "modified": modified,
        "created": created,
        "readonly": meta.permissions().readonly(),
    }))
}

/// Show a native "Save As…" dialog and write the given text content to the
/// chosen path. Used by Export Chat (markdown / JSON). Returns the chosen
/// path, or null when the user cancelled.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn save_text_file_dialog(
    content: String,
    defaultName: Option<String>,
    extension: Option<String>,
    ext_label: Option<String>,
) -> Result<Option<String>, String> {
    let default_name = defaultName.unwrap_or_else(|| "export.txt".to_string());
    let ext = extension.unwrap_or_else(|| "txt".to_string());
    let label = ext_label.unwrap_or_else(|| format!("{} file", ext.to_uppercase()));

    // rfd::AsyncFileDialog runs the native Windows/macOS/Linux save dialog
    // without any extra Tauri plugin.
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter(&label, &[ext.as_str()])
        .save_file()
        .await;

    match file {
        Some(handle) => {
            let path = handle.path().to_path_buf();
            std::fs::write(&path, content).map_err(|e| format!("Write failed: {}", e))?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}
