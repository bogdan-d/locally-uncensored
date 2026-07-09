// Account lifecycle for the LU Cloud tier: keychain session restore on boot,
// email+password login/logout, and a 5-minute /api/me + quota probe while
// signed in. Also auto-enables the 'lu-cloud' chat provider whenever the
// account has token budget, so cloud models appear in the chat picker without
// any manual provider setup.

import { useCallback, useEffect, useRef } from 'react'
import { supabaseCloud } from '../api/cloud/supabase'
import { getMe, getQuota } from '../api/cloud/jobs'
import { useCloudAuthStore } from '../stores/cloudAuthStore'
import { useProviderStore } from '../stores/providerStore'
import type { CloudQuota } from '../lib/render/cloud-jobs'

const REFRESH_MS = 5 * 60_000

async function probeAccount(): Promise<void> {
  const store = useCloudAuthStore.getState()
  try {
    const me = await getMe()
    if (!me.user) {
      store.setSignedOut()
      syncChatProvider(null)
      return
    }
    const licenseActive = me.license?.status === 'active'
    let quota: CloudQuota | null = null
    if (licenseActive) {
      quota = await getQuota().catch(() => null)
    }
    store.setSignedIn({ id: me.user.id, email: me.user.email }, licenseActive, quota)
    syncChatProvider(quota)
  } catch {
    // 401 = no/expired session; network = cloud unreachable. Either way the
    // cloud axis is off for now — local features are unaffected.
    store.setSignedOut()
    syncChatProvider(null)
  }
}

// Chat side of the account: the lu-cloud provider is enabled exactly when the
// tier has a token budget. Uses the store action so the registry cache clears.
function syncChatProvider(quota: CloudQuota | null): void {
  const enabled = (quota?.limits.tokens ?? 0) > 0
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
    syncChatProvider(null)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    await probeAccount()
  }, [])

  return { status, user, login, signup, logout, refresh }
}
