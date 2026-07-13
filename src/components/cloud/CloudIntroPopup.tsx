// One-time "LU Cloud is here" hello (David 2026-07-13, shipped with 2.5.7).
// Every install sees this exactly once on its first launch after onboarding,
// auto-updaters and fresh installs alike, then never again: any way of
// closing it writes the localStorage flag, and that flag rides the
// store-backup list so even an NSIS localStorage wipe can't resurrect it.
// Deliberately tiny and angular: the monogram, one line, two buttons. "Check
// out the Cloud" opens the same CloudGateModal the header switch uses.

import { useEffect, useState } from 'react'
import { Modal } from '../ui/Modal'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'

export const CLOUD_INTRO_KEY = 'lu_cloud_intro_seen'

/** Pure visibility rule, exported for tests. Users already running in cloud
 *  mode never get pitched — the flag is written for them silently instead. */
export function shouldShowCloudIntro(alreadySeen: boolean, appMode: string): boolean {
  return !alreadySeen && appMode !== 'cloud'
}

export function CloudIntroPopup() {
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const setCloudGateOpen = useUIStore((s) => s.setCloudGateOpen)
  const [open, setOpen] = useState(false)

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

  const close = () => {
    try { localStorage.setItem(CLOUD_INTRO_KEY, '1') } catch { /* ignore */ }
    setOpen(false)
  }

  const checkOut = () => {
    close()
    setCloudGateOpen(true)
  }

  return (
    <Modal open={open} onClose={close} hideHeader maxWidth="max-w-[260px]" panelRadius="rounded-lg" panelPad="p-5">
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
          LU Cloud is live.
        </div>
        <div className="w-full flex flex-col gap-1.5">
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
