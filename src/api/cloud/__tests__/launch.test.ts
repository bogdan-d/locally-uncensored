import { describe, it, expect } from 'vitest'
import { waveDays, launchCopy } from '../launch'

// Anchored to the live sample moment (endpoint Date header 2026-07-14T09:31Z,
// wave 2026-07-20T19:00Z) so the day math matches what the real popup shows.
const NOW = Date.parse('2026-07-14T09:31:54Z')

describe('waveDays', () => {
  it('ceils whole days to the wave (spec: Math.ceil((t - now)/86400000))', () => {
    expect(waveDays('2026-07-20T19:00:00Z', NOW)).toBe(7)
  })
  it('is null with no date', () => {
    expect(waveDays(null, NOW)).toBeNull()
  })
  it('is null once the wave has already passed', () => {
    expect(waveDays('2026-07-14T00:00:00Z', NOW)).toBeNull()
  })
  it('is null for an unparseable date', () => {
    expect(waveDays('not-a-date', NOW)).toBeNull()
  })
})

describe('launchCopy', () => {
  it('normal state: remaining / cap / days', () => {
    const c = launchCopy(
      { cap: 50, taken: 2, remaining: 48, soldOut: false, nextWaveAt: '2026-07-20T19:00:00Z' },
      NOW,
    )
    expect(c.title).toBe('LU Cloud is here')
    expect(c.detail).toBe('48 of 50 founding spots left this week. Opens to everyone in 7 days.')
  })

  it('sold-out: no buy pitch, cap in the title', () => {
    const c = launchCopy(
      { cap: 50, taken: 50, remaining: 0, soldOut: true, nextWaveAt: '2026-07-20T19:00:00Z' },
      NOW,
    )
    expect(c.title).toBe('Founding wave full (50 spots)')
    expect(c.detail).toBe('Opens to everyone in 7 days.')
  })

  it('uncapped: omits the spots copy entirely (never "null spots")', () => {
    const c = launchCopy(
      { cap: null, taken: null, remaining: null, soldOut: false, nextWaveAt: '2026-07-20T19:00:00Z' },
      NOW,
    )
    expect(c.title).toBe('LU Cloud is here')
    expect(c.detail).toBe('Opens to everyone in 7 days.')
  })

  it('singular day', () => {
    const c = launchCopy(
      { cap: 50, taken: 2, remaining: 48, soldOut: false, nextWaveAt: '2026-07-15T00:00:00Z' },
      NOW,
    )
    expect(c.detail).toBe('48 of 50 founding spots left this week. Opens to everyone in 1 day.')
  })

  it('no wave date: drops the "opens in" clause', () => {
    const c = launchCopy(
      { cap: 50, taken: 2, remaining: 48, soldOut: false, nextWaveAt: null },
      NOW,
    )
    expect(c.detail).toBe('48 of 50 founding spots left this week.')
  })

  it('fetch failed (null) → numberless fallback, never a guess', () => {
    const c = launchCopy(null, NOW)
    expect(c.title).toBe('LU Cloud is here')
    expect(c.detail).toBe('Limited founding spots available.')
  })
})
