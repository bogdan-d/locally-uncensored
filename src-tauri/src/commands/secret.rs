//! OS keychain storage for provider API keys (security fix H5) and the LU
//! Cloud session.
//!
//! Provider keys used to live in localStorage under reversible base64
//! (providerStore.ts). On Windows + macOS we store them in the OS credential
//! vault instead — Windows Credential Manager / macOS Keychain, via the
//! `keyring` crate. Both backends ship with the OS, so no extra system library
//! is pulled in, and the secret is bound to the user's login.
//!
//! Windows caps a single credential blob at CRED_MAX_CREDENTIAL_BLOB_SIZE
//! (2560 bytes = 1280 UTF-16 units) and keyring pre-flights every write
//! against it, so the ~2–4 KB supabase session JSON can never fit in one
//! entry. Values over the per-entry budget are therefore split across
//! `account#0`, `account#1`, … with a short `__lu_chunks__:<n>` marker under
//! the base account. macOS has no such limit and keeps single-entry writes;
//! short values are stored identically on both platforms, and plain values
//! written by older builds read back unchanged.
//!
//! Linux desktop and the web build have no robust uniform secret store here
//! (the secret-service backend needs libdbus/gnome-keyring and breaks on
//! headless/minimal setups), so those keep the obfuscated-localStorage path:
//! on those targets the commands compile to a stub that reports "unsupported",
//! and the frontend (providerStore.hydrateProviderKeys) falls back.

/// Keychain service name. The "account" is the provider id (ollama / openai /
/// anthropic). Keep this stable — changing it would orphan stored keys.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const SERVICE: &str = "com.locallyuncensored.providerkeys";

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod chunked {
    use super::SERVICE;

    /// Per-entry budget in UTF-16 units. keyring's windows-native backend
    /// rejects blobs over 2560 bytes (1280 units) — stay comfortably under.
    /// macOS has no limit, so it never chunks and writes stay single-entry.
    const MAX_UNITS: usize = if cfg!(target_os = "windows") { 1000 } else { usize::MAX };

    /// Head marker for a chunked value. No provider key or session JSON ever
    /// starts with this, so plain pre-existing entries read back unchanged.
    const MARKER: &str = "__lu_chunks__:";

    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
    }

    fn chunk_account(account: &str, i: usize) -> String {
        format!("{account}#{i}")
    }

    fn delete_entry(account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Chunk count recorded in the head entry; 0 when absent or plain.
    fn stored_chunks(account: &str) -> Result<usize, String> {
        match entry(account)?.get_password() {
            Ok(head) => Ok(parse_marker(&head).unwrap_or(0)),
            Err(keyring::Error::NoEntry) => Ok(0),
            Err(e) => Err(e.to_string()),
        }
    }

    pub(super) fn parse_marker(head: &str) -> Option<usize> {
        head.strip_prefix(MARKER)?.parse().ok()
    }

    /// Split at char boundaries so every piece stays within `max_units`
    /// UTF-16 units — the unit keyring measures the blob size in.
    pub(super) fn split_units(value: &str, max_units: usize) -> Vec<String> {
        let mut chunks = Vec::new();
        let mut cur = String::new();
        let mut units = 0usize;
        for ch in value.chars() {
            let n = ch.len_utf16();
            if units + n > max_units && !cur.is_empty() {
                chunks.push(std::mem::take(&mut cur));
                units = 0;
            }
            cur.push(ch);
            units += n;
        }
        if !cur.is_empty() {
            chunks.push(cur);
        }
        chunks
    }

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        // Best-effort read of the previous layout so a shrinking value leaves
        // no orphaned chunk entries behind.
        let old = stored_chunks(account).unwrap_or(0);
        if value.encode_utf16().count() <= MAX_UNITS {
            entry(account)?.set_password(value).map_err(|e| e.to_string())?;
            for i in 0..old {
                let _ = delete_entry(&chunk_account(account, i));
            }
            return Ok(());
        }
        // Chunks first, marker last — a torn write keeps the old head (and
        // thus the old value) readable.
        let parts = split_units(value, MAX_UNITS);
        for (i, part) in parts.iter().enumerate() {
            entry(&chunk_account(account, i))?
                .set_password(part)
                .map_err(|e| e.to_string())?;
        }
        entry(account)?
            .set_password(&format!("{MARKER}{}", parts.len()))
            .map_err(|e| e.to_string())?;
        for i in parts.len()..old {
            let _ = delete_entry(&chunk_account(account, i));
        }
        Ok(())
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        let head = match entry(account)?.get_password() {
            Ok(v) => v,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        let Some(count) = parse_marker(&head) else {
            return Ok(Some(head));
        };
        let mut value = String::new();
        for i in 0..count {
            match entry(&chunk_account(account, i))?.get_password() {
                Ok(part) => value.push_str(&part),
                // A missing chunk is a torn write — report absent, not corrupt.
                Err(keyring::Error::NoEntry) => return Ok(None),
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(Some(value))
    }

    pub fn delete(account: &str) -> Result<(), String> {
        let count = stored_chunks(account)?;
        delete_entry(account)?;
        for i in 0..count {
            delete_entry(&chunk_account(account, i))?;
        }
        Ok(())
    }
}

/// Test-only kill switch for the OS keychain. A rebuilt ad-hoc-signed app gets a
/// fresh code-signing hash, so macOS re-prompts for the login password on the
/// first keychain read after every rebuild — which stalls unattended
/// rebuild→open test loops. When `LU_NO_KEYCHAIN` is set (env var, or a
/// `~/.lu-no-keychain` marker file), the secret commands report the keychain as
/// unavailable; the frontend adapters (supabase.ts session, providerStore keys)
/// then latch to their localStorage path and never touch the keychain.
///
/// SECURITY (review 2.5.7): this bypass is gated behind the `insecure-test-keychain`
/// Cargo feature, which is NOT in any default and is never enabled in a shipped
/// build. In a release binary the whole env/marker check compiles out to `false`,
/// so a same-user process cannot drop `~/.lu-no-keychain` (or set the env var) to
/// silently downgrade the Supabase session + provider keys to plaintext
/// localStorage. Only builds made with `--features insecure-test-keychain` honor it.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn keychain_disabled() -> bool {
    #[cfg(not(feature = "insecure-test-keychain"))]
    {
        false
    }
    #[cfg(feature = "insecure-test-keychain")]
    {
        if let Some(v) = std::env::var_os("LU_NO_KEYCHAIN") {
            if !v.is_empty() {
                return true;
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            if std::path::Path::new(&home).join(".lu-no-keychain").exists() {
                return true;
            }
        }
        false
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    // An empty value means "no key" — delete rather than store an empty secret,
    // so a cleared key never lingers in the vault.
    if value.is_empty() {
        return chunked::delete(&account);
    }
    chunked::set(&account, &value)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    chunked::get(&account)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    chunked::delete(&account)
}

// ── Non-keychain platforms (Linux desktop) ──────────────────────────────
// The commands still exist so `invoke('secret_get', …)` resolves, but they
// report unsupported. The frontend treats any error here as "no keychain" and
// keeps using the obfuscated-localStorage path — identical to today's behavior.

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[tauri::command]
pub fn secret_set(_account: String, _value: String) -> Result<(), String> {
    Err("keychain unsupported on this platform".into())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[tauri::command]
pub fn secret_get(_account: String) -> Result<Option<String>, String> {
    Err("keychain unsupported on this platform".into())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[tauri::command]
pub fn secret_delete(_account: String) -> Result<(), String> {
    Err("keychain unsupported on this platform".into())
}

#[cfg(all(test, any(target_os = "windows", target_os = "macos")))]
mod tests {
    use super::chunked::{parse_marker, split_units};

    #[test]
    fn short_value_stays_whole() {
        assert_eq!(split_units("abc", 1000), vec!["abc".to_string()]);
        assert!(split_units("", 1000).is_empty());
    }

    #[test]
    fn split_respects_utf16_budget_and_rejoins_losslessly() {
        // Multi-unit chars near the boundary must not be torn apart.
        let value = format!("{}é🦀 tail", "x".repeat(2500));
        let parts = split_units(&value, 1000);
        assert!(parts.len() >= 3);
        assert!(parts.iter().all(|p| p.encode_utf16().count() <= 1000));
        assert_eq!(parts.concat(), value);
    }

    #[test]
    fn marker_parses_and_plain_values_pass_through() {
        assert_eq!(parse_marker("__lu_chunks__:4"), Some(4));
        assert_eq!(parse_marker("__lu_chunks__:x"), None);
        assert_eq!(parse_marker("eyJhbGciOiJIUzI1NiJ9.payload.sig"), None);
    }
}
