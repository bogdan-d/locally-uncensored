// One-time Cloud onboarding (David 2026-07-10): the FIRST successful flip to
// Cloud lands here instead of switching silently — a short what-changes
// walkthrough, then the switch flips and cloudOnboardingSeen persists so it
// never shows again. "Not now" leaves everything on Local.

import { Cloud, Coins, Shield } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'

const POINTS = [
  {
    icon: Cloud,
    title: 'Hosted models everywhere',
    body: "Chat, image and video switch to LU's hosted GPU fleet — the full cloud catalog, no downloads, no VRAM limits. The Create tab gains the cloud-only ops (edit, animate, upscale, erase, enhance).",
  },
  {
    icon: Coins,
    title: 'Your plan pays with credits',
    body: 'Every render and chat draws from the monthly credit budget of your plan — the meter in Create always shows what is left. Local-hardware surfaces (Model Manager, Benchmark) hide while Cloud is on.',
  },
  {
    icon: Shield,
    title: 'Local stays local',
    body: 'Cloud mode is a switch, not a migration: flip back to Local anytime and everything runs on this machine again — free, private, no account needed.',
  },
]

export function CloudOnboardingModal() {
  const open = useUIStore((s) => s.cloudOnboardingOpen)
  const setOpen = useUIStore((s) => s.setCloudOnboardingOpen)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const start = () => {
    updateSettings({ appMode: 'cloud', cloudOnboardingSeen: true })
    setOpen(false)
  }

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Welcome to LU Cloud">
      <div className="space-y-4">
        {POINTS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#7c3aed]/10 text-[#7c3aed] dark:text-[#a78bfa]">
              <Icon size={14} />
            </span>
            <div className="space-y-0.5">
              <p className="text-[0.75rem] font-medium text-gray-900 dark:text-gray-100">{title}</p>
              <p className="text-[0.7rem] leading-relaxed text-gray-600 dark:text-gray-400">{body}</p>
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={start}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[0.7rem] font-medium bg-[#7c3aed] text-white hover:opacity-90 transition-opacity"
          >
            <Cloud size={11} /> Start Cloud mode
          </button>
          <button
            onClick={() => setOpen(false)}
            className="px-3 py-1.5 rounded text-[0.7rem] font-medium border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          >
            Not now
          </button>
        </div>
      </div>
    </Modal>
  )
}
