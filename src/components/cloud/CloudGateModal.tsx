// The gate in front of the global Cloud mode. Opened by the header's
// Local/Cloud switch whenever the cloud axis isn't usable yet; walks the
// account through its actual blocker and flips the mode the moment
// deriveCloudAvailable passes:
//   signed-out            → login (email+password + Google/GitHub)
//   licensed? no          → plan CTA → lu-labs.ai/pricing in the browser
//   beta gate (access=no) → closed-beta copy → lu-labs.ai
//   no credit budget      → honest copy → lu-labs.ai/account in the browser
// Payment stays on lu-labs.ai (browser) — the app never touches Stripe.

import { useEffect, useRef } from 'react'
import { Cloud, ExternalLink, RefreshCw } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCloudAuthStore, deriveCloudAvailable } from '../../stores/cloudAuthStore'
import { useCloudAuth } from '../../hooks/useCloudAuth'
import { AccountPanel } from '../auth/AccountPanel'
import { CLOUD_BASE } from '../../api/cloud/config'
import { openExternal } from '../../api/backend'

export function CloudGateModal() {
  const open = useUIStore((s) => s.cloudGateOpen)
  const setOpen = useUIStore((s) => s.setCloudGateOpen)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const { refresh } = useCloudAuth()

  const status = useCloudAuthStore((s) => s.status)
  const user = useCloudAuthStore((s) => s.user)
  const licenseActive = useCloudAuthStore((s) => s.licenseActive)
  const access = useCloudAuthStore((s) => s.access)
  const quota = useCloudAuthStore((s) => s.quota)
  const available = deriveCloudAvailable({ user, licenseActive, access, quota })

  // The moment the account clears every gate (fresh login, re-check after
  // subscribing), flip the global switch and get out of the way.
  const wasOpen = useRef(false)
  useEffect(() => {
    wasOpen.current = open
  }, [open])
  useEffect(() => {
    if (wasOpen.current && available) {
      updateSettings({ appMode: 'cloud' })
      setOpen(false)
    }
  }, [available, setOpen, updateSettings])

  // Re-probe on open — someone staring at this gate shouldn't wait for the
  // 5-minute background interval to clear a transient quota-fetch failure.
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const linkBtn =
    'flex items-center gap-1.5 px-3 py-1.5 rounded text-[0.7rem] font-medium bg-gray-900 text-white dark:bg-white dark:text-gray-900 hover:opacity-90 transition-opacity'
  const ghostBtn =
    'flex items-center gap-1.5 px-3 py-1.5 rounded text-[0.7rem] font-medium border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors'

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="LU Cloud">
      {status === 'signed-out' || !user ? (
        <div className="space-y-3">
          <p className="text-[0.75rem] text-gray-600 dark:text-gray-400 flex items-start gap-2">
            <Cloud size={14} className="mt-0.5 shrink-0" />
            Cloud mode runs chat, image and video on LU's hosted GPUs with your
            lu-labs.ai account. Local mode stays free and never needs one.
          </p>
          <AccountPanel />
        </div>
      ) : !licenseActive ? (
        <div className="space-y-3">
          <p className="text-[0.75rem] text-gray-600 dark:text-gray-400">
            You're signed in as <span className="text-gray-900 dark:text-gray-100">{user.email ?? user.id}</span>,
            but this account has no active plan yet. LU Cloud is part of the paid plans on lu-labs.ai.
          </p>
          <div className="flex items-center gap-2">
            <button className={linkBtn} onClick={() => void openExternal(`${CLOUD_BASE}/pricing`)}>
              <ExternalLink size={11} /> View plans on lu-labs.ai
            </button>
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={11} /> I subscribed — re-check
            </button>
          </div>
        </div>
      ) : !access ? (
        <div className="space-y-3">
          <p className="text-[0.75rem] text-gray-600 dark:text-gray-400">
            LU Cloud is in a closed beta right now (Max plan only). Your plan is
            active, but the beta hasn't opened for it yet — you'll get in the
            moment it does, nothing to reinstall.
          </p>
          <div className="flex items-center gap-2">
            <button className={linkBtn} onClick={() => void openExternal(`${CLOUD_BASE}/pricing`)}>
              <ExternalLink size={11} /> Open lu-labs.ai
            </button>
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={11} /> Re-check
            </button>
          </div>
        </div>
      ) : quota === null ? (
        <div className="space-y-3">
          <p className="text-[0.75rem] text-gray-600 dark:text-gray-400">
            Your plan is active, but your usage couldn't be loaded just now, so
            Cloud mode can't switch on yet. Check your connection and re-check.
          </p>
          <div className="flex items-center gap-2">
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={11} /> Re-check
            </button>
          </div>
        </div>
      ) : quota.limits.credits <= 0 ? (
        <div className="space-y-3">
          <p className="text-[0.75rem] text-gray-600 dark:text-gray-400">
            Your plan is active, but it doesn't include a hosted-compute credit
            budget, so there's nothing for Cloud mode to run on. Plans with
            cloud credits are on lu-labs.ai.
          </p>
          <div className="flex items-center gap-2">
            <button className={linkBtn} onClick={() => void openExternal(`${CLOUD_BASE}/account`)}>
              <ExternalLink size={11} /> Open your account on lu-labs.ai
            </button>
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={11} /> Re-check
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[0.75rem] text-gray-600 dark:text-gray-400">Checking your account…</p>
      )}
    </Modal>
  )
}
