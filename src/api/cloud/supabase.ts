// Supabase auth client for the LU Cloud tier. Desktop authenticates directly
// against Supabase — email+password in-app, Google/GitHub via the system
// browser (PKCE + 127.0.0.1 loopback, see loginWithProvider) — and the
// resulting access token is sent as `Authorization: Bearer` to lu-labs.ai.
//
// Session storage: OS keychain via the existing Rust `secret_*` commands
// (Windows Credential Manager / macOS Keychain) — survives the NSIS-update
// WebView2 wipe and keeps refresh tokens out of localStorage. Linux and the
// browser dev build fall back to localStorage (same tiering as providerStore).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { secretGet, secretSet, secretDelete, oauthStart, oauthWait, openExternal } from '../backend'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config'

const SESSION_ACCOUNT = 'lu-cloud-session'
const LOCAL_KEY = 'lu-cloud-session'

// Keychain-first async storage adapter. A single failed keychain call flips
// the adapter to localStorage for the rest of the session (Linux, web dev).
let keychainBroken = false

// The PKCE flow stores TWO keys through this adapter: the session under the
// storageKey and the code verifier under `${storageKey}-code-verifier`. Map
// each supabase key to its own keychain account (suffix-preserving, so the
// pre-2.5.7 session account stays exactly SESSION_ACCOUNT) — a single fixed
// account would let the verifier write clobber the session.
function keychainAccount(key: string): string {
  return key.startsWith(LOCAL_KEY) ? SESSION_ACCOUNT + key.slice(LOCAL_KEY.length) : key
}

const keychainStorage = {
  async getItem(key: string): Promise<string | null> {
    if (!keychainBroken) {
      try {
        return await secretGet(keychainAccount(key))
      } catch {
        keychainBroken = true
      }
    }
    return localStorage.getItem(key)
  },
  async setItem(key: string, value: string): Promise<void> {
    if (!keychainBroken) {
      try {
        await secretSet(keychainAccount(key), value)
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
        await secretDelete(keychainAccount(key))
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
        // OAuth via the system browser needs PKCE — the browser only ever
        // sees the code, the verifier stays in the app (keychain adapter).
        flowType: 'pkce',
      },
    })
  }
  return client
}

/** Current access token, refreshing an expired session if needed. Null when
 *  logged out. Called per request — getSession() is cached in-memory and only
 *  hits the network when the token actually expired. A failed refresh with the
 *  session still in the keychain is a connectivity problem, not a sign-out —
 *  throw so callers don't tell a signed-in user to sign in. */
export async function getAccessToken(): Promise<string | null> {
  const { data, error } = await supabaseCloud().auth.getSession()
  if (!data.session && error) {
    throw new Error('LU Cloud unreachable — check your connection.')
  }
  return data.session?.access_token ?? null
}

export type OAuthProvider = 'google' | 'github'

/** Google/GitHub sign-in, same identities as lu-labs.ai. Flow: bind a
 *  127.0.0.1 loopback port (Rust, fixed ladder registered in the Supabase
 *  redirect allow-list) → open the provider consent in the SYSTEM browser →
 *  Supabase redirects to the loopback with ?code= → exchange the PKCE code
 *  for a session. Rejects with a readable message on timeout/denial, and
 *  immediately when `signal` aborts (Cancel while waiting for the browser) —
 *  the abandoned Rust wait cleans itself up, and any retry's oauth_start
 *  aborts the stale listener first, so cancelling never wedges the ladder. */
export async function loginWithProvider(provider: OAuthProvider, signal?: AbortSignal): Promise<void> {
  const port = await oauthStart()
  const { data, error } = await supabaseCloud().auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `http://127.0.0.1:${port}/callback`,
      skipBrowserRedirect: true,
    },
  })
  if (error) throw new Error(error.message)
  if (!data?.url) throw new Error('OAuth start failed — no provider URL')
  await openExternal(data.url)
  const wait = oauthWait(port, 300)
  const query = signal
    ? await Promise.race([
        wait,
        new Promise<never>((_, reject) => {
          const cancel = () => reject(new Error('Sign-in cancelled.'))
          if (signal.aborted) cancel()
          else signal.addEventListener('abort', cancel, { once: true })
        }),
      ])
    : await wait
  const params = new URLSearchParams(query)
  const code = params.get('code')
  if (!code) {
    throw new Error(params.get('error_description') || params.get('error') || 'Sign-in was cancelled in the browser.')
  }
  const { error: exchangeError } = await supabaseCloud().auth.exchangeCodeForSession(code)
  if (exchangeError) throw new Error(exchangeError.message)
}
