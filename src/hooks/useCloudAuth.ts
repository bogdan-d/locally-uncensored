// Account lifecycle for the LU Cloud tier: keychain session restore on boot,
// email+password login/logout, and a 5-minute /api/me + quota probe while
// signed in. Also auto-enables the 'lu-cloud' chat provider whenever the
// account has token budget, so cloud models appear in the chat picker without
// any manual provider setup.

import { useCallback, useEffect, useRef } from 'react'
import { supabaseCloud } from '../api/cloud/supabase'
import { getMe, getQuota } from '../api/cloud/jobs'
import { useCloudAuthStore, deriveCloudAvailable } from '../stores/cloudAuthStore'
import { refreshCatalog } from '../stores/cloudCatalogStore'
import { useProviderStore } from '../stores/providerStore'
import type { CloudQuota } from '../lib/render/cloud-jobs'

const REFRESH_MS = 5 * 60_000

async function probeAccount(): Promise<void> {
  const store = useCloudAuthStore.getState()
  try {
    const me = await getMe()
    if (!me.user) {
      store.setSignedOut()
      syncChatProvider()
      return
    }
    const licenseActive = me.license?.status === 'active'
    // Launch gate (Max-only closed beta): absent on older servers = allowed.
    const access = me.license?.access !== false
    const tier = me.license?.tier ?? null
    let quota: CloudQuota | null = null
    if (licenseActive && access) {
      // Gated accounts would just 403 here — skip the round-trip.
      quota = await getQuota().catch(() => null)
      void refreshCatalog()
    }
    store.setSignedIn({ id: me.user.id, email: me.user.email }, { licenseActive, tier, access, quota })
    syncChatProvider()
  } catch {
    // 401 = no/expired session; network = cloud unreachable. Either way the
    // cloud axis is off for now — local features are unaffected.
    store.setSignedOut()
    syncChatProvider()
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
    const timer = setInterval(() => {
      if (useCloudAuthStore.getState().status === 'signed-in') void probeAccount()
    }, REFRESH_MS)
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
    await supabaseCloud().auth.signOut().catch(() => {})
    useCloudAuthStore.getState().setSignedOut()
    syncChatProvider()
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    await probeAccount()
  }, [])

  return { status, user, login, signup, logout, refresh }
}
