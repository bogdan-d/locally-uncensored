// LU Cloud account state. Deliberately NOT persisted: the session itself
// lives in the OS keychain (api/cloud/supabase.ts storage adapter) and
// user/tier/quota are re-derived from /api/me + /api/jobs/quota on boot —
// a persisted copy could only ever be stale.

import { create } from 'zustand'
import type { CloudQuota } from '../lib/render/cloud-jobs'

export interface CloudUser {
  id: string
  email?: string
}

export interface CloudAccount {
  licenseActive: boolean
  /** Canonical tier slug from /api/me, null while signed out/unknown. */
  tier: string | null
  /** Launch gate (Max-only closed beta). Licensed-but-gated users get the
   *  closed-beta wall instead of the cloud. */
  access: boolean
  quota: CloudQuota | null
}

interface CloudAuthState extends CloudAccount {
  /** 'probing' until the keychain session restore + first /api/me resolve. */
  status: 'probing' | 'signed-out' | 'signed-in'
  user: CloudUser | null

  setSignedOut: () => void
  setSignedIn: (user: CloudUser, account: CloudAccount) => void
  setQuota: (quota: CloudQuota | null) => void
}

export const useCloudAuthStore = create<CloudAuthState>()((set) => ({
  status: 'probing',
  user: null,
  licenseActive: false,
  tier: null,
  access: true,
  quota: null,

  setSignedOut: () =>
    set({ status: 'signed-out', user: null, licenseActive: false, tier: null, access: true, quota: null }),
  setSignedIn: (user, account) => set({ status: 'signed-in', user, ...account }),
  setQuota: (quota) => set({ quota }),
}))

/** The whole cloud axis in one predicate: signed in, actively licensed,
 *  through the launch gate, and on a tier whose monthly credit budget is > 0
 *  (self-host tiers report 0). */
export function deriveCloudAvailable(state: {
  user: CloudUser | null
  licenseActive: boolean
  access: boolean
  quota: CloudQuota | null
}): boolean {
  return Boolean(state.user && state.licenseActive && state.access && (state.quota?.limits.credits ?? 0) > 0)
}
