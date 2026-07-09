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

interface CloudAuthState {
  /** 'probing' until the keychain session restore + first /api/me resolve. */
  status: 'probing' | 'signed-out' | 'signed-in'
  user: CloudUser | null
  licenseActive: boolean
  quota: CloudQuota | null

  setSignedOut: () => void
  setSignedIn: (user: CloudUser, licenseActive: boolean, quota: CloudQuota | null) => void
  setQuota: (quota: CloudQuota | null) => void
}

export const useCloudAuthStore = create<CloudAuthState>()((set) => ({
  status: 'probing',
  user: null,
  licenseActive: false,
  quota: null,

  setSignedOut: () =>
    set({ status: 'signed-out', user: null, licenseActive: false, quota: null }),
  setSignedIn: (user, licenseActive, quota) =>
    set({ status: 'signed-in', user, licenseActive, quota }),
  setQuota: (quota) => set({ quota }),
}))

/** The whole cloud axis in one predicate: signed in, actively licensed, and
 *  on a tier whose monthly media budget is > 0 (self-host tiers report 0). */
export function deriveCloudAvailable(state: {
  user: CloudUser | null
  licenseActive: boolean
  quota: CloudQuota | null
}): boolean {
  return Boolean(state.user && state.licenseActive && (state.quota?.limits.credits ?? 0) > 0)
}
