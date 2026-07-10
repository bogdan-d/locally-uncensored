// The gate in front of the global Cloud mode. Opened by the header's purple
// Cloud switch whenever the cloud axis isn't usable yet. David 2026-07-10:
// every no-subscription state offers FOUR options — back to Local (switch
// stays off) or one of the three plans (Hosted / Pro / Max), which open
// lu-labs.ai/pricing in the browser (login → pay there). Signed-out
// additionally offers the in-app login for accounts that already subscribed.
// The moment deriveCloudAvailable passes, the mode flips — via the one-time
// cloud onboarding on the very first flip.
// Payment stays on lu-labs.ai (browser) — the app never touches Stripe.

import { useEffect, useRef } from 'react'
import { Cloud, ExternalLink, HardDrive, RefreshCw } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCloudAuthStore, deriveCloudAvailable } from '../../stores/cloudAuthStore'
import { useCloudAuth } from '../../hooks/useCloudAuth'
import { AccountPanel } from '../auth/AccountPanel'
import { CLOUD_BASE } from '../../api/cloud/config'
import { openExternal } from '../../api/backend'

const PLANS = [
  { anchor: 'hosted', name: 'Hosted' },
  { anchor: 'pro', name: 'Pro' },
  { anchor: 'max', name: 'Max' },
] as const

/** David's 4-options block: three plan buttons → pricing in the browser,
 *  plus "Stay on Local" so the switch simply stays off. */
function PlanOptions({ onLocal }: { onLocal: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-[0.65rem] text-gray-500 dark:text-gray-500">
        Pick a plan on lu-labs.ai — payment stays in the browser.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {PLANS.map((p) => (
          <button
            key={p.anchor}
            onClick={() => void openExternal(`${CLOUD_BASE}/pricing#${p.anchor}`)}
            className="flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border border-[#7c3aed]/40 bg-[#7c3aed]/5 hover:bg-[#7c3aed]/15 transition-colors"
          >
            <span className="text-[0.7rem] font-semibold text-[#7c3aed] dark:text-[#a78bfa]">{p.name}</span>
            <span className="flex items-center gap-1 text-[0.55rem] text-gray-500">
              <ExternalLink size={8} /> lu-labs.ai
            </span>
          </button>
        ))}
      </div>
      <button
        onClick={onLocal}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-[0.7rem] font-medium border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
      >
        <HardDrive size={11} /> Stay on Local
      </button>
    </div>
  )
}

export function CloudGateModal() {
  const open = useUIStore((s) => s.cloudGateOpen)
  const setOpen = useUIStore((s) => s.setCloudGateOpen)
  const setCloudOnboardingOpen = useUIStore((s) => s.setCloudOnboardingOpen)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const cloudOnboardingSeen = useSettingsStore((s) => s.settings.cloudOnboardingSeen)
  const { refresh } = useCloudAuth()

  const status = useCloudAuthStore((s) => s.status)
  const user = useCloudAuthStore((s) => s.user)
  const licenseActive = useCloudAuthStore((s) => s.licenseActive)
  const access = useCloudAuthStore((s) => s.access)
  const quota = useCloudAuthStore((s) => s.quota)
  const available = deriveCloudAvailable({ user, licenseActive, access, quota })

  // The moment the account clears every gate (fresh login, re-check after
  // subscribing), flip the global switch and get out of the way — via the
  // one-time cloud onboarding when this is the first successful flip.
  const wasOpen = useRef(false)
  useEffect(() => {
    wasOpen.current = open
  }, [open])
  useEffect(() => {
    if (wasOpen.current && available) {
      setOpen(false)
      if (!cloudOnboardingSeen) setCloudOnboardingOpen(true)
      else updateSettings({ appMode: 'cloud' })
    }
  }, [available, cloudOnboardingSeen, setCloudOnboardingOpen, setOpen, updateSettings])

  const stayLocal = () => {
    updateSettings({ appMode: 'local' })
    setOpen(false)
  }

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
          <PlanOptions onLocal={stayLocal} />
          <div className="pt-1 border-t border-gray-200 dark:border-white/10">
            <p className="text-[0.65rem] text-gray-500 dark:text-gray-500 pt-2 pb-1">
              Already subscribed? Sign in:
            </p>
            <AccountPanel />
          </div>
        </div>
      ) : !licenseActive ? (
        <div className="space-y-3">
          <p className="text-[0.75rem] text-gray-600 dark:text-gray-400">
            You're signed in as <span className="text-gray-900 dark:text-gray-100">{user.email ?? user.id}</span>,
            but this account has no active plan yet. LU Cloud is part of the paid plans on lu-labs.ai.
          </p>
          <PlanOptions onLocal={stayLocal} />
          <button className={ghostBtn} onClick={() => void refresh()}>
            <RefreshCw size={11} /> I subscribed — re-check
          </button>
        </div>
      ) : !access ? (
        <div className="space-y-3">
          <p className="text-[0.75rem] text-gray-600 dark:text-gray-400">
            LU Cloud is in a closed beta right now (Max plan only). Your plan is
            active, but the beta hasn't opened for it yet — you'll get in the
            moment it does, nothing to reinstall.
          </p>
          <PlanOptions onLocal={stayLocal} />
          <button className={ghostBtn} onClick={() => void refresh()}>
            <RefreshCw size={11} /> Re-check
          </button>
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
