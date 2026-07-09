// Supabase auth client for the LU Cloud tier. Desktop authenticates directly
// against Supabase (email+password) with the public anon key; the resulting
// access token is sent as `Authorization: Bearer` to the lu-labs.ai APIs.
//
// Session storage: OS keychain via the existing Rust `secret_*` commands
// (Windows Credential Manager / macOS Keychain) — survives the NSIS-update
// WebView2 wipe and keeps refresh tokens out of localStorage. Linux and the
// browser dev build fall back to localStorage (same tiering as providerStore).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { secretGet, secretSet, secretDelete } from '../backend'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config'

const SESSION_ACCOUNT = 'lu-cloud-session'
const LOCAL_KEY = 'lu-cloud-session'

// Keychain-first async storage adapter. A single failed keychain call flips
// the adapter to localStorage for the rest of the session (Linux, web dev).
let keychainBroken = false

// There is exactly one session per app: the keychain path stores under a
// fixed account; the localStorage fallback keys by the (equally fixed)
// storageKey supabase passes in.
const keychainStorage = {
  async getItem(key: string): Promise<string | null> {
    if (!keychainBroken) {
      try {
        return await secretGet(SESSION_ACCOUNT)
      } catch {
        keychainBroken = true
      }
    }
    return localStorage.getItem(key)
  },
  async setItem(key: string, value: string): Promise<void> {
    if (!keychainBroken) {
      try {
        await secretSet(SESSION_ACCOUNT, value)
        return
      } catch {
        keychainBroken = true
      }
    }
    localStorage.setItem(key, value)
  },
  async removeItem(key: string): Promise<void> {
    if (!keychainBroken) {
      try {
        await secretDelete(SESSION_ACCOUNT)
        return
      } catch {
        keychainBroken = true
      }
    }
    localStorage.removeItem(key)
  },
}

let client: SupabaseClient | null = null

export function supabaseCloud(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: keychainStorage,
        storageKey: LOCAL_KEY,
        persistSession: true,
        // Timers are throttled while the app is minimized/asleep, so we do
        // NOT rely on background refresh — getAccessToken() refreshes lazily
        // via getSession() on every use instead.
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  }
  return client
}

/** Current access token, refreshing an expired session if needed. Null when
 *  logged out. Called per request — getSession() is cached in-memory and only
 *  hits the network when the token actually expired. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabaseCloud().auth.getSession()
  return data.session?.access_token ?? null
}
