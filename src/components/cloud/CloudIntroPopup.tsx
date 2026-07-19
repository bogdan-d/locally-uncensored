// THE one Cloud popup at app start (David 2026-07-19, 2.5.8): every install
// sees this exactly once on its first launch after onboarding, then never
// again — any way of closing it writes the localStorage flag, and that flag
// rides the store-backup list so even an NSIS localStorage wipe can't
// resurrect it. Two choices only: "Sign in or create account" opens the
// normal in-app gate (login / plans; payment leaves for the browser from
// there), and an equally visible "I don't want an account" which ALSO retires
// the whole Cloud discovery layer (picker teaser rows, tap-sheets) via
// cloudTeasersEnabled — after that tap, nothing Cloud pitches you again.
// Settings can re-enable the discovery layer later.
//
// It reads the founding-wave seat count LIVE from /api/launch/seats each time
// it opens (the server sends no-store) — never a cached or guessed number.

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
  const updateSettings = useSettingsStore((s) => s.updateSettings)
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

  const signIn = () => {
    // Open the normal in-app onboarding gate (login / Get LU Cloud), not the
    // website directly — payment leaves for the browser from there.
    close()
    setCloudGateOpen(true)
  }

  const decline = () => {
    // "I don't want an account": beyond the once-ever close, retire the whole
    // Cloud discovery layer so nothing pitches Cloud again (Settings can
    // re-enable it). Cloud-only tools keep their tap-gate — that is feature
    // access, not a pitch.
    updateSettings({ cloudTeasersEnabled: false })
    close()
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
            onClick={signIn}
            className="w-full px-3 py-2 rounded-md text-[0.7rem] font-medium text-white bg-[#7c3aed] hover:bg-[#6d31d6] transition-colors"
          >
            Sign in or create account
          </button>
          <button
            onClick={decline}
            className="w-full px-3 py-2 rounded-md text-[0.7rem] font-medium text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-white/15 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          >
            I don't want an account
          </button>
        </div>
      </div>
    </Modal>
  )
}
