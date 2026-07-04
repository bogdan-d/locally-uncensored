// The Create surface's view of the cloud axis — same contract as uselu's
// useCloudSession, but derived from the shared cloudAuthStore (fed by
// useCloudAuth's probes) instead of its own /api/me polling.

import { useCallback } from 'react'
import { useCloudAuthStore, deriveCloudAvailable } from '../stores/cloudAuthStore'
import { getQuota } from '../api/cloud/jobs'
import type { CloudQuota } from '../lib/render/cloud-jobs'

export interface CloudSession {
  user: { id: string; email?: string } | null
  licenseActive: boolean
  quota: CloudQuota | null
  /** true ⇔ signed in + active license + a tier with a media-credit budget. */
  cloudAvailable: boolean
  refreshQuota: () => Promise<void>
}

export function useCloudSession(): CloudSession {
  const user = useCloudAuthStore((s) => s.user)
  const licenseActive = useCloudAuthStore((s) => s.licenseActive)
  const quota = useCloudAuthStore((s) => s.quota)

  const refreshQuota = useCallback(async () => {
    try {
      const q = await getQuota()
      useCloudAuthStore.getState().setQuota(q)
    } catch {
      useCloudAuthStore.getState().setQuota(null)
    }
  }, [])

  return {
    user,
    licenseActive,
    quota,
    cloudAvailable: deriveCloudAvailable({ user, licenseActive, quota }),
    refreshQuota,
  }
}
