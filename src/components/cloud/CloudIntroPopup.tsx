// One-time "LU Cloud is here" hello (David 2026-07-13, shipped with 2.5.7).
// Every install sees this exactly once on its first launch after onboarding,
// auto-updaters and fresh installs alike, then never again: any way of closing
// it writes the localStorage flag, and that flag rides the store-backup list so
// even an NSIS localStorage wipe can't resurrect it.
//
// It reads the founding-wave seat count LIVE from /api/launch/seats each time it
// opens (the server sends no-store) — never a cached or guessed number. Copy
// splits the spec's line into a bold title + gray detail (same words, no
// em-dash). "Check out the Cloud" opens the normal in-app gate (Get LU Cloud /
// Stay on Local); payment leaves for the browser from the plan buttons there.

import { useEffect, useState } from 'react'
import { Modal } from '../ui/Modal'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getLaunchSeats, launchCopy, type LaunchSeats } from '../../api/cloud/launch'

export const CLOUD_INTRO_KEY = 'lu_cloud_intro_seen'

/** Pure visibility rule, exported for tests. Users already running in cloud
 *  mode never get pitched — the flag is written for them silently instead. */
export function shouldShowCloudIntro(alreadySeen: boolean, appMode: string): boolean {
  return !alreadySeen && appMode !== 'cloud'
}

type SeatState =
  | { phase: 'loading' }
  | { phase: 'ready'; seats: LaunchSeats }
  | { phase: 'error' }

export function CloudIntroPopup() {
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const setCloudGateOpen = useUIStore((s) => s.setCloudGateOpen)
  const [open, setOpen] = useState(false)
  const [seatState, setSeatState] = useState<SeatState>({ phase: 'loading' })

  useEffect(() => {
    let seen = false
    try {
      seen = localStorage.getItem(CLOUD_INTRO_KEY) === '1'
    } catch {
      // storage unavailable — never loop the popup, just skip it
      return
    }
    if (!shouldShowCloudIntro(seen, appMode)) {
      // cloud users skip the pitch, but the once-ever contract still holds
      if (!seen) try { localStorage.setItem(CLOUD_INTRO_KEY, '1') } catch { /* ignore */ }
      return
    }
    // let the main UI settle for a beat before saying hello
    const t = setTimeout(() => setOpen(true), 900)
    return () => clearTimeout(t)
    // mount-only on purpose: a later appMode flip must not re-arm the popup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live seat count, fetched fresh the moment the popup opens — no caching, per
  // the endpoint's no-store. A failure falls back to numberless copy; an abort
  // (popup closed mid-flight) is swallowed.
  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    setSeatState({ phase: 'loading' })
    getLaunchSeats(ac.signal)
      .then((seats) => setSeatState({ phase: 'ready', seats }))
      .catch(() => { if (!ac.signal.aborted) setSeatState({ phase: 'error' }) })
    return () => ac.abort()
  }, [open])

  const close = () => {
    try { localStorage.setItem(CLOUD_INTRO_KEY, '1') } catch { /* ignore */ }
    setOpen(false)
  }

  const checkOut = () => {
    // Open the normal in-app onboarding gate (Get LU Cloud / Stay on Local),
    // not the website directly — payment leaves for the browser from there.
    close()
    setCloudGateOpen(true)
  }

  // Loading shows the headline alone (no flash of wrong numbers); ready uses the
  // live seats; error uses the numberless fallback.
  const copy =
    seatState.phase === 'ready'
      ? launchCopy(seatState.seats, Date.now())
      : seatState.phase === 'error'
        ? launchCopy(null, Date.now())
        : { title: 'LU Cloud is here', detail: '' }

  return (
    <Modal open={open} onClose={close} hideHeader maxWidth="max-w-[280px]" panelRadius="rounded-lg" panelPad="p-5">
      <div className="flex flex-col items-center text-center gap-3">
        <img
          src="/LU-monogram-bw.png"
          alt=""
          width={40}
          height={40}
          className="dark:invert-0 invert opacity-90 select-none"
          draggable={false}
        />
        <div className="text-[0.8rem] font-semibold tracking-tight text-gray-900 dark:text-gray-100">
          {copy.title}
        </div>
        {copy.detail && (
          <div className="text-[0.68rem] leading-relaxed text-gray-600 dark:text-gray-400">
            {copy.detail}
          </div>
        )}
        <div className="w-full flex flex-col gap-1.5 pt-1">
          <button
            onClick={checkOut}
            className="w-full px-3 py-2 rounded-md text-[0.7rem] font-medium text-white bg-[#7c3aed] hover:bg-[#6d31d6] transition-colors"
          >
            Check out the Cloud
          </button>
          <button
            onClick={close}
            className="w-full px-3 py-1.5 rounded-md text-[0.65rem] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </Modal>
  )
}
