// GET /api/launch/seats — the public, unauthenticated founding-wave seat count
// behind the one-time "LU Cloud is here" popup. The server sends `no-store`, so
// we read it LIVE on every popup open and deliberately never cache it: a
// dismissed-then-reshown popup (or a later build) always reflects the real
// remaining seats, never a stale or guessed number. Same origin as the rest of
// the cloud API, so the desktop CSP connect-src + CORS already cover it.

import { CLOUD_BASE } from './config'

export interface LaunchSeats {
  /** Founding-wave seat cap. null once the wave is uncapped/open to all. */
  cap: number | null
  taken: number | null
  /** Seats left. null when uncapped — then the spots copy is omitted entirely. */
  remaining: number | null
  soldOut: boolean
  /** ISO timestamp the wave opens to everyone, or null. */
  nextWaveAt: string | null
}

/** Live fetch, no cache (the server sets `no-store`). Throws on any non-2xx or
 *  network error so the caller falls back to numberless copy — never a guess. */
export async function getLaunchSeats(signal?: AbortSignal): Promise<LaunchSeats> {
  const res = await fetch(`${CLOUD_BASE}/api/launch/seats`, { cache: 'no-store', signal })
  if (!res.ok) throw new Error(`launch/seats ${res.status}`)
  return (await res.json()) as LaunchSeats
}

/** Whole days until the wave opens, ceil'd (spec: Math.ceil((t - now)/86400000)).
 *  null when there's no date or it has already passed, so the caller drops the
 *  "opens in …" clause instead of showing "0 days" or a negative count. */
export function waveDays(nextWaveAt: string | null, now: number): number | null {
  if (!nextWaveAt) return null
  const t = Date.parse(nextWaveAt)
  if (Number.isNaN(t)) return null
  const days = Math.ceil((t - now) / 86_400_000)
  return days > 0 ? days : null
}

export interface LaunchCopy {
  title: string
  detail: string
}

/** Popup copy for a seat state. `null` seats = the fetch failed → a numberless
 *  fallback ("Limited founding spots available."), never a guessed or cached
 *  number. Pure and exported so the state matrix is unit-tested. */
export function launchCopy(seats: LaunchSeats | null, now: number): LaunchCopy {
  if (!seats) {
    return { title: 'LU Cloud is here', detail: 'Limited founding spots available.' }
  }
  const days = waveDays(seats.nextWaveAt, now)
  const opens = days !== null ? `Opens to everyone in ${days} ${days === 1 ? 'day' : 'days'}.` : ''

  if (seats.soldOut) {
    // Sold-out: no purchase pitch, just the notice + when it opens to all.
    const cap = seats.cap != null ? ` (${seats.cap} spots)` : ''
    return { title: `Founding wave full${cap}`, detail: opens }
  }
  if (seats.cap != null && seats.remaining != null) {
    const spots = `${seats.remaining} of ${seats.cap} founding spots left this week.`
    return { title: 'LU Cloud is here', detail: opens ? `${spots} ${opens}` : spots }
  }
  // Uncapped → omit the spots copy entirely (never "null spots").
  return { title: 'LU Cloud is here', detail: opens }
}
