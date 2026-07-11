// The gate in front of the global Cloud mode. Opened by the header's purple
// Cloud switch whenever the cloud axis isn't usable yet.
//
// David 2026-07-11 redesign: a CENTERED, STEPPED flow instead of one crowded
// screen. Signed-out walks: (1) a "LU Cloud" hero with the hosted-GPU pitch,
// (2) the three plans to pick + "Stay on Local", with "Already got an account?"
// underneath → (3) the in-app sign-in. Every no-subscription state still offers
// back-to-Local or a plan (Hosted / Pro / Max → lu-labs.ai/pricing). The moment
// deriveCloudAvailable passes, the mode flips (via the one-time onboarding on
// the first flip). Payment stays on lu-labs.ai — the app never touches Stripe.

import { useEffect, useRef, useState } from 'react'
import { Cloud, ExternalLink, HardDrive, RefreshCw, ArrowLeft, ArrowRight } from 'lucide-react'
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

/** Three plan buttons → pricing in the browser. */
function PlanGrid() {
  return (
    <div className="grid grid-cols-3 gap-2">
      {PLANS.map((p) => (
        <button
          key={p.anchor}
          onClick={() => void openExternal(`${CLOUD_BASE}/pricing#${p.anchor}`)}
          className="flex flex-col items-center gap-0.5 px-2 py-3 rounded-lg border border-[#7c3aed]/40 bg-[#7c3aed]/5 hover:bg-[#7c3aed]/15 transition-colors"
        >
          <span className="text-[0.8rem] font-semibold text-[#7c3aed] dark:text-[#a78bfa]">{p.name}</span>
          <span className="flex items-center gap-1 text-[0.55rem] text-gray-500">
            <ExternalLink size={8} /> lu-labs.ai
          </span>
        </button>
      ))}
    </div>
  )
}

function StayLocalButton({ onLocal }: { onLocal: () => void }) {
  return (
    <button
      onClick={onLocal}
      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.72rem] font-medium border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
    >
      <HardDrive size={12} /> Stay on Local
    </button>
  )
}

/** The purple cloud emblem that headlines every step. */
function CloudHero({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex flex-col items-center text-center gap-2">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#7c3aed]/10 text-[#7c3aed] dark:text-[#a78bfa]">
        <Cloud size={24} />
      </span>
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white">LU Cloud</h2>
      {subtitle && (
        <p className="text-[0.75rem] leading-relaxed text-gray-600 dark:text-gray-400 max-w-xs">{subtitle}</p>
      )}
    </div>
  )
}

type Step = 'intro' | 'plans' | 'login'

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

  // Signed-out walkthrough position. Reset to the hero every time the gate
  // opens so a re-open never lands mid-flow.
  const [step, setStep] = useState<Step>('intro')
  useEffect(() => { if (open) setStep('intro') }, [open])

  // The moment the account clears every gate (fresh login, re-check after
  // subscribing), flip the global switch and get out of the way — via the
  // one-time cloud onboarding when this is the first successful flip.
  const wasOpen = useRef(false)
  useEffect(() => { wasOpen.current = open }, [open])
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

  const primaryBtn =
    'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.72rem] font-medium bg-[#7c3aed] text-white hover:opacity-90 transition-opacity'
  const ghostBtn =
    'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.72rem] font-medium border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors'
  const linkRow =
    'flex items-center justify-center gap-1 text-[0.68rem] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors'

  const signedOut = status === 'signed-out' || !user

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="LU Cloud" hideHeader>
      {signedOut ? (
        step === 'intro' ? (
          <div className="space-y-5 pt-2">
            <CloudHero subtitle="Run chat, image and video on LU's hosted GPU fleet with your lu-labs.ai account — the full cloud catalog, no downloads, no VRAM limits. Local mode stays free and never needs an account." />
            <div className="space-y-2 max-w-xs mx-auto">
              <button onClick={() => setStep('plans')} className={primaryBtn}>
                Get LU Cloud <ArrowRight size={13} />
              </button>
              <StayLocalButton onLocal={stayLocal} />
            </div>
          </div>
        ) : step === 'plans' ? (
          <div className="space-y-5 pt-2">
            <CloudHero subtitle="Pick a plan on lu-labs.ai — payment stays in the browser." />
            <div className="space-y-3 max-w-xs mx-auto">
              <PlanGrid />
              <StayLocalButton onLocal={stayLocal} />
              <div className="pt-1 flex items-center gap-2">
                <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
                <span className="text-[0.6rem] text-gray-400 dark:text-gray-600">or</span>
                <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
              </div>
              <button onClick={() => setStep('login')} className={linkRow + ' w-full'}>
                Already got an account? Sign in <ArrowRight size={11} />
              </button>
            </div>
          </div>
        ) : (
          /* step === 'login' */
          <div className="space-y-4 pt-2">
            <CloudHero subtitle="Sign in with the account you subscribed with." />
            <div className="max-w-xs mx-auto">
              <AccountPanel />
              <button onClick={() => setStep('plans')} className={linkRow + ' w-full mt-3'}>
                <ArrowLeft size={11} /> Back to plans
              </button>
            </div>
          </div>
        )
      ) : !licenseActive ? (
        <div className="space-y-5 pt-2">
          <CloudHero />
          <div className="space-y-3 max-w-xs mx-auto">
            <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
              You're signed in as <span className="text-gray-900 dark:text-gray-100">{user.email ?? user.id}</span>,
              but this account has no active plan yet. LU Cloud is part of the paid plans.
            </p>
            <PlanGrid />
            <StayLocalButton onLocal={stayLocal} />
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={12} /> I subscribed — re-check
            </button>
          </div>
        </div>
      ) : !access ? (
        <div className="space-y-5 pt-2">
          <CloudHero />
          <div className="space-y-3 max-w-xs mx-auto">
            <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
              LU Cloud is in a closed beta right now (Max plan only). Your plan is
              active, but the beta hasn't opened for it yet — you'll get in the
              moment it does, nothing to reinstall.
            </p>
            <StayLocalButton onLocal={stayLocal} />
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={12} /> Re-check
            </button>
          </div>
        </div>
      ) : quota === null ? (
        <div className="space-y-5 pt-2">
          <CloudHero />
          <div className="space-y-3 max-w-xs mx-auto">
            <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
              Your plan is active, but your usage couldn't be loaded just now, so
              Cloud mode can't switch on yet. Check your connection and re-check.
            </p>
            <StayLocalButton onLocal={stayLocal} />
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={12} /> Re-check
            </button>
          </div>
        </div>
      ) : quota.limits.credits <= 0 ? (
        <div className="space-y-5 pt-2">
          <CloudHero />
          <div className="space-y-3 max-w-xs mx-auto">
            <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
              Your plan is active, but it doesn't include a hosted-compute credit
              budget, so there's nothing for Cloud mode to run on. Plans with
              cloud credits are on lu-labs.ai.
            </p>
            <button className={primaryBtn} onClick={() => void openExternal(`${CLOUD_BASE}/account`)}>
              <ExternalLink size={12} /> Open your account
            </button>
            <StayLocalButton onLocal={stayLocal} />
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={12} /> Re-check
            </button>
          </div>
        </div>
      ) : (
        <div className="pt-2">
          <CloudHero subtitle="Checking your account…" />
        </div>
      )}
    </Modal>
  )
}
