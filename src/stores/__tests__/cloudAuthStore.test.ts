import { describe, it, expect, beforeEach } from 'vitest'
import { useCloudAuthStore, deriveCloudAvailable } from '../cloudAuthStore'
import type { CloudQuota } from '../../lib/render/cloud-jobs'

const quota = (credits: number): CloudQuota => ({
  tier: 'hosted',
  period: '2026-07',
  limits: { credits },
  costs: { image: 5, video: 80 },
  used: { credits_used: 0 },
  remaining: { credits },
})

const account = (over: Partial<Parameters<typeof deriveCloudAvailable>[0]> & { quota: CloudQuota | null }) => ({
  licenseActive: true,
  tier: 'hosted-max',
  access: true,
  ...over,
})

beforeEach(() => {
  useCloudAuthStore.getState().setSignedOut()
})

describe('cloudAuthStore', () => {
  it('setSignedIn stores user, license, tier, gate and quota', () => {
    useCloudAuthStore
      .getState()
      .setSignedIn(
        { id: 'u1', email: 'qa@lu-labs.ai' },
        { licenseActive: true, tier: 'hosted-max', access: true, quota: quota(800) },
      )
    const s = useCloudAuthStore.getState()
    expect(s.status).toBe('signed-in')
    expect(s.user?.email).toBe('qa@lu-labs.ai')
    expect(s.licenseActive).toBe(true)
    expect(s.tier).toBe('hosted-max')
    expect(s.access).toBe(true)
    expect(s.quota?.limits.credits).toBe(800)
  })

  it('setSignedOut clears everything', () => {
    useCloudAuthStore
      .getState()
      .setSignedIn({ id: 'u1' }, { licenseActive: true, tier: 'hosted-max', access: true, quota: quota(800) })
    useCloudAuthStore.getState().setSignedOut()
    const s = useCloudAuthStore.getState()
    expect(s.status).toBe('signed-out')
    expect(s.user).toBeNull()
    expect(s.licenseActive).toBe(false)
    expect(s.tier).toBeNull()
    expect(s.quota).toBeNull()
  })
})

describe('deriveCloudAvailable', () => {
  it('requires signed-in + active license + launch gate + credit budget', () => {
    expect(deriveCloudAvailable({ user: null, ...account({ licenseActive: false, quota: null }) })).toBe(false)
    expect(deriveCloudAvailable({ user: { id: 'u' }, ...account({ licenseActive: false, quota: quota(800) }) })).toBe(false)
    expect(deriveCloudAvailable({ user: { id: 'u' }, ...account({ quota: null }) })).toBe(false)
    // self-host tier: licensed but 0 media credits
    expect(deriveCloudAvailable({ user: { id: 'u' }, ...account({ quota: quota(0) }) })).toBe(false)
    // Server-driven access gate (legacy closed-beta wall): access false gates out
    expect(deriveCloudAvailable({ user: { id: 'u' }, ...account({ access: false, quota: quota(800) }) })).toBe(false)
    expect(deriveCloudAvailable({ user: { id: 'u' }, ...account({ quota: quota(800) }) })).toBe(true)
  })
})
