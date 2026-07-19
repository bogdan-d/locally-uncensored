// Account lifecycle for the LU Cloud tier: keychain session restore on boot,
// email+password login/logout, and a 5-minute /api/me + quota probe. Also
// auto-enables the 'lu-cloud' chat provider whenever the account has token
// budget, so cloud models appear in the chat picker without any manual
// provider setup.

import { useCallback, useEffect, useRef } from 'react'
import { supabaseCloud } from '../api/cloud/supabase'
import { CloudJobError } from '../api/cloud/client'
import { getMe, getQuota } from '../api/cloud/jobs'
import { useCloudAuthStore, deriveCloudAvailable } from '../stores/cloudAuthStore'
import { refreshCatalog } from '../stores/cloudCatalogStore'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { CloudQuota } from '../lib/render/cloud-jobs'

const REFRESH_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 15_000

// Probe generation guard: probeAccount runs concurrently (boot, interval tick,
// login/signup/refresh) with no other coordination, and its fetches carry the
// access token captured at request time. A probe that hangs on a dead
// connection and resolves after a logout/account-switch must not write its
// stale result over the newer state — every probe start (and logout) bumps the
// generation, and a probe only touches the store while it is still the newest.
let probeGen = 0

// getMe/getQuota take no AbortSignal, so bound the wait here — the abandoned
// response, if it ever arrives, is discarded by the generation guard.
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cloud probe timed out')), PROBE_TIMEOUT_MS)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

async function probeAccount(): Promise<void> {
  const gen = ++probeGen
  const stale = () => gen !== probeGen
  const store = useCloudAuthStore.getState()
  try {
    const me = await withTimeout(getMe())
    if (stale()) return
    if (!me.user) {
      store.setSignedOut()
      syncChatProvider()
      syncAppMode()
      return
    }
    const licenseActive = me.license?.status === 'active'
    // Server-driven access gate (beta is fully open — servers send true for
    // every licensed account): absent on older servers = allowed.
    const access = me.license?.access !== false
    const tier = me.license?.tier ?? null
    let quota: CloudQuota | null = null
    if (licenseActive && access) {
      // Gated accounts would just 403 here — skip the round-trip. A transient
      // quota-fetch failure keeps the last-known quota instead of collapsing
      // the whole cloud axis; only an auth/gate rejection clears it.
      quota = await withTimeout(getQuota()).catch((err) =>
        err instanceof CloudJobError && (err.status === 401 || err.status === 403)
          ? null
          : useCloudAuthStore.getState().quota,
      )
      if (stale()) return
      void refreshCatalog()
    }
    store.setSignedIn({ id: me.user.id, email: me.user.email }, { licenseActive, tier, access, quota })
    syncChatProvider()
    syncAppMode()
  } catch (err) {
    if (stale()) return
    // Only a definitive auth rejection (401/403) signs out. Network errors,
    // 5xx and timeouts are transient: keep the session and let the next
    // interval tick retry. The boot probe still resolves to signed-out so the
    // UI never hangs in 'probing'.
    const authFailure = err instanceof CloudJobError && (err.status === 401 || err.status === 403)
    if (authFailure || useCloudAuthStore.getState().status === 'probing') {
      store.setSignedOut()
      syncChatProvider()
      syncAppMode()
    }
  }
}

// Never strand the app in cloud mode without a usable cloud: sign-out,
// license loss or the beta gate flips the global switch back to Local.
function syncAppMode(): void {
  const settings = useSettingsStore.getState()
  if (settings.settings.appMode === 'cloud' && !deriveCloudAvailable(useCloudAuthStore.getState())) {
    settings.updateSettings({ appMode: 'local' })
  }
}

// Chat side of the account: the lu-cloud provider is enabled exactly when the
// whole cloud axis is (signed in + licensed + gate + credit budget). Uses the
// store action so the registry cache clears.
function syncChatProvider(): void {
  const enabled = deriveCloudAvailable(useCloudAuthStore.getState())
  const current = useProviderStore.getState().providers['lu-cloud']
  if (current && current.enabled !== enabled) {
    useProviderStore.getState().setProviderConfig('lu-cloud', { enabled })
    // setProviderConfig alone doesn't refetch anyone's model list — kick the
    // shared refresh event so the hosted catalog appears in the chat picker
    // the moment the account signs in (and vanishes on sign-out).
    window.dispatchEvent(new CustomEvent('lu-models-refresh'))
  }
}

export function useCloudAuth() {
  const status = useCloudAuthStore((s) => s.status)
  const user = useCloudAuthStore((s) => s.user)
  const armed = useRef(false)

  useEffect(() => {
    if (armed.current) return
    armed.current = true
    void probeAccount()
    // Probe on every tick regardless of status: an offline boot or a
    // transient failure self-heals once connectivity returns, instead of
    // stranding the app signed-out until a manual re-probe.
    const timer = setInterval(() => void probeAccount(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const { error } = await supabaseCloud().auth.signInWithPassword({ email, password })
    if (error) throw new Error(error.message)
    await probeAccount()
  }, [])

  const signup = useCallback(async (email: string, password: string): Promise<void> => {
    const { error } = await supabaseCloud().auth.signUp({ email, password })
    if (error) throw new Error(error.message)
    // Autoconfirm is on server-side — a fresh signup is immediately signed in.
    await probeAccount()
  }, [])

  const logout = useCallback(async (): Promise<void> => {
    // Invalidate any in-flight probe — its request carried the old (still
    // unexpired) access token and would resurrect the signed-in state.
    probeGen++
    await supabaseCloud().auth.signOut().catch(() => {})
    useCloudAuthStore.getState().setSignedOut()
    syncChatProvider()
    syncAppMode()
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    await probeAccount()
  }, [])

  return { status, user, login, signup, logout, refresh }
}
