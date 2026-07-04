/**
 * Provider Store — manages provider configurations.
 *
 * Stores endpoint URLs, API keys (encrypted), and enabled state.
 * Ollama is always enabled by default.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ProviderId, ProviderConfig } from '../api/providers/types'
import { clearProviderCache } from '../api/providers/registry'
import { secretGet, secretSet, secretDelete } from '../api/backend'
import { CLOUD_BASE } from '../api/cloud/config'

// ── API Key storage ────────────────────────────────────────────
// Two-tier (H5):
//   • Windows + macOS desktop → the real key lives in the OS credential vault
//     (Credential Manager / Keychain) via the Rust secret_* commands.
//     `keychainReady` flips true once hydrateProviderKeys confirms the vault
//     works; partialize then keeps the key out of localStorage entirely.
//   • Linux desktop + the web build → no robust uniform vault, so the key stays
//     in localStorage under the base64 obfuscation below (unchanged behavior).
// In-memory we always hold the OBFUSCATED form so the sync getters
// (getProviderApiKey / getEnabledProviders) are identical on every platform.

function obfuscate(key: string): string {
  if (!key) return ''
  try {
    return btoa(key.split('').reverse().join(''))
  } catch {
    return key
  }
}

function deobfuscate(encoded: string): string {
  if (!encoded) return ''
  try {
    return atob(encoded).split('').reverse().join('')
  } catch {
    return encoded
  }
}

// Flipped true by hydrateProviderKeys when the OS keychain is usable on this
// platform. Until then (and forever on Linux/web) the store behaves exactly as
// before. Module-level so the static `partialize` can read it.
let keychainReady = false
const PROVIDER_IDS: ProviderId[] = ['ollama', 'openai', 'anthropic']
// Providers whose OS-vault WRITE failed this session. partialize keeps their
// obfuscated key in localStorage as a fallback so a flaky/locked credential
// store can't silently drop the key on the next restart.
const _keychainFailed = new Set<ProviderId>()

// ── Default provider configs ───────────────────────────────────

const DEFAULT_PROVIDERS: Record<ProviderId, ProviderConfig> = {
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    enabled: true,
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    isLocal: true,
  },
  openai: {
    id: 'openai',
    name: 'LM Studio',
    enabled: false,
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    isLocal: true,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    enabled: false,
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    isLocal: false,
  },
  // LU Cloud chat (lu-labs.ai inference proxy). apiKey stays empty forever —
  // auth is the user's Supabase session token, injected per request by
  // LuCloudProvider. useCloudAuth flips `enabled` with the account state.
  'lu-cloud': {
    id: 'lu-cloud',
    name: 'LU Cloud',
    enabled: false,
    baseUrl: `${CLOUD_BASE}/api/inference/v1`,
    apiKey: '',
    isLocal: false,
  },
}

// ── Store Interface ────────────────────────────────────────────

interface ProviderState {
  providers: Record<ProviderId, ProviderConfig>
  /** Persisted: user opted out of the multi-backend selector modal. When true,
   * AppShell never re-shows the modal on startup even if multiple backends are
   * running. User can still add / remove providers via Settings → Providers. */
  hideBackendSelector: boolean

  setProviderConfig: (id: ProviderId, updates: Partial<ProviderConfig>) => void
  setProviderApiKey: (id: ProviderId, key: string) => void
  getProviderApiKey: (id: ProviderId) => string
  getEnabledProviders: () => ProviderConfig[]
  resetProvider: (id: ProviderId) => void
  setHideBackendSelector: (hide: boolean) => void
  /** H5: load provider keys from the OS keychain (Win/macOS), migrating any
   * existing localStorage key into the vault. No-op / fallback elsewhere.
   * Call once at app startup, before the first provider client is built. */
  hydrateProviderKeys: () => Promise<void>
}

// ── Zustand Store ──────────────────────────────────────────────

export const useProviderStore = create<ProviderState>()(
  persist(
    (set, get) => ({
      providers: DEFAULT_PROVIDERS,
      hideBackendSelector: false,

      setHideBackendSelector: (hide) => set({ hideBackendSelector: hide }),

      setProviderConfig: (id, updates) => {
        set((state) => ({
          providers: {
            ...state.providers,
            [id]: { ...state.providers[id], ...updates },
          },
        }))
        clearProviderCache() // invalidate cached clients
      },

      setProviderApiKey: (id, key) => {
        set((state) => ({
          providers: {
            ...state.providers,
            [id]: { ...state.providers[id], apiKey: obfuscate(key) },
          },
        }))
        // When the OS vault is active, store the real key there; partialize then
        // keeps it out of localStorage. If the vault WRITE fails (locked / policy
        // / full), mark this id so partialize RETAINS the obfuscated key in
        // localStorage — otherwise it would vanish on the next restart with no
        // trace (the in-memory value only serves this session).
        if (keychainReady) {
          _keychainFailed.delete(id)
          secretSet(id, key).catch(() => {
            _keychainFailed.add(id)
            set((s) => ({ providers: { ...s.providers } })) // re-persist with the fallback retained
          })
        }
        clearProviderCache()
      },

      getProviderApiKey: (id) => {
        return deobfuscate(get().providers[id]?.apiKey || '')
      },

      getEnabledProviders: () => {
        const providers = get().providers
        return Object.values(providers)
          .filter((p) => p.enabled)
          .map((p) => ({
            ...p,
            apiKey: deobfuscate(p.apiKey), // deobfuscate for use
          }))
      },

      resetProvider: (id) => {
        set((state) => ({
          providers: {
            ...state.providers,
            [id]: DEFAULT_PROVIDERS[id],
          },
        }))
        if (keychainReady) {
          void secretDelete(id).catch(() => { /* vault delete best-effort */ })
        }
        clearProviderCache()
      },

      hydrateProviderKeys: async () => {
        // Probe + load keys from the OS keychain. The first secret_get that
        // RESOLVES (even returning null) proves the vault is usable here; a
        // reject on the very first probe means no keychain (web build, or Linux
        // "unsupported") → stay on the localStorage path and do nothing.
        const next = { ...get().providers }
        let usable: boolean | null = null
        for (const id of PROVIDER_IDS) {
          try {
            const stored = await secretGet(id)
            usable = true
            if (stored != null && stored !== '') {
              next[id] = { ...next[id], apiKey: obfuscate(stored) }
            } else {
              // Nothing in the vault yet. Migrate an existing localStorage key
              // (an upgrading user) into the vault, once.
              const existing = deobfuscate(next[id]?.apiKey || '')
              if (existing) {
                // Migrate the old localStorage key into the vault. If the write
                // fails, mark it so partialize keeps the localStorage copy (no loss).
                try { await secretSet(id, existing) } catch { _keychainFailed.add(id) }
              }
            }
          } catch {
            if (usable === null) { usable = false; break } // no keychain here
            // otherwise a transient per-key error — keep the others
          }
        }
        if (!usable) return
        keychainReady = true
        // Apply loaded keys and re-persist; partialize (now that keychainReady
        // is true) strips the redundant localStorage copy. clearProviderCache
        // rebuilds any client constructed during startup with an empty key.
        set({ providers: next })
        clearProviderCache()
      },
    }),
    {
      name: 'lu-providers',
      version: 1,
      // Blobs persisted before the lu-cloud provider existed lack its entry —
      // backfill every missing provider from defaults so getProvider() can't
      // hit an undefined config after an update.
      merge: (persisted: unknown, current: ProviderState): ProviderState => {
        const p = (persisted ?? {}) as Partial<ProviderState>
        return {
          ...current,
          ...p,
          providers: { ...DEFAULT_PROVIDERS, ...(p.providers ?? {}) },
        }
      },
      // Don't persist transient state, only configs + user's "don't show again" preference.
      // When the OS keychain is active (H5), strip apiKey so the secret never
      // touches localStorage; otherwise keep the obfuscated key as before.
      partialize: (state) => ({
        providers: keychainReady
          ? (Object.fromEntries(
              Object.entries(state.providers).map(([id, p]) =>
                // Strip the key (it lives in the vault) UNLESS the vault write
                // failed for this id — then keep the obfuscated fallback.
                _keychainFailed.has(id as ProviderId) ? [id, p] : [id, { ...p, apiKey: '' }]
              )
            ) as Record<ProviderId, ProviderConfig>)
          : state.providers,
        hideBackendSelector: state.hideBackendSelector,
      }),
    }
  )
)
