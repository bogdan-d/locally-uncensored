import { describe, it, expect, beforeEach } from 'vitest'
import { useCloudAuthStore, deriveCloudAvailable } from '../cloudAuthStore'
import type { CloudQuota } from '../../lib/render/cloud-jobs'

const quota = (credits: number, tokens = 0): CloudQuota => ({
  tier: 'hosted',
  period: '2026-07',
  limits: { tokens, credits },
  costs: { image: 5, video: 80 },
  used: { tokens_used: 0, credits_used: 0 },
  remaining: { tokens, credits },
})

beforeEach(() => {
  useCloudAuthStore.getState().setSignedOut()
})

describe('cloudAuthStore', () => {
  it('setSignedIn stores user, license and quota', () => {
    useCloudAuthStore.getState().setSignedIn({ id: 'u1', email: 'qa@lu-labs.ai' }, true, quota(800))
    const s = useCloudAuthStore.getState()
    expect(s.status).toBe('signed-in')
    expect(s.user?.email).toBe('qa@lu-labs.ai')
    expect(s.licenseActive).toBe(true)
    expect(s.quota?.limits.credits).toBe(800)
  })

  it('setSignedOut clears everything', () => {
    useCloudAuthStore.getState().setSignedIn({ id: 'u1' }, true, quota(800))
    useCloudAuthStore.getState().setSignedOut()
    const s = useCloudAuthStore.getState()
    expect(s.status).toBe('signed-out')
    expect(s.user).toBeNull()
    expect(s.licenseActive).toBe(false)
    expect(s.quota).toBeNull()
  })
})

describe('deriveCloudAvailable', () => {
  it('requires signed-in + active license + credit budget', () => {
    expect(deriveCloudAvailable({ user: null, licenseActive: false, quota: null })).toBe(false)
    expect(deriveCloudAvailable({ user: { id: 'u' }, licenseActive: false, quota: quota(800) })).toBe(false)
    expect(deriveCloudAvailable({ user: { id: 'u' }, licenseActive: true, quota: null })).toBe(false)
    // self-host tier: licensed but 0 media credits
    expect(deriveCloudAvailable({ user: { id: 'u' }, licenseActive: true, quota: quota(0) })).toBe(false)
    expect(deriveCloudAvailable({ user: { id: 'u' }, licenseActive: true, quota: quota(800) })).toBe(true)
  })
})
