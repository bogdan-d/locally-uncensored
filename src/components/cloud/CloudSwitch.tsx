// The purple Cloud light-switch (header, right cluster, left of Downloads —
// David 2026-07-10, purple like the lu-labs.ai website). ON = the whole app
// runs on LU Cloud: hosted models everywhere, local-hardware surfaces hidden.
// Flipping ON only succeeds when the cloud axis is usable (signed in +
// licensed + beta gate + credit budget) — otherwise the CloudGateModal walks
// the account through login / the three plans. The very FIRST successful flip
// shows the one-time cloud onboarding instead of switching silently. Flipping
// OFF always works.

import { Cloud } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { useCloudAuthStore, deriveCloudAvailable } from '../../stores/cloudAuthStore'
import { cn } from '../create/ui/cn'

export function CloudSwitch() {
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const cloudOnboardingSeen = useSettingsStore((s) => s.settings.cloudOnboardingSeen)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const setCloudGateOpen = useUIStore((s) => s.setCloudGateOpen)
  const setCloudOnboardingOpen = useUIStore((s) => s.setCloudOnboardingOpen)
  const available = useCloudAuthStore(deriveCloudAvailable)
  const on = appMode === 'cloud'

  const toggle = () => {
    if (on) {
      updateSettings({ appMode: 'local' })
      return
    }
    if (!available) {
      setCloudGateOpen(true)
      return
    }
    if (!cloudOnboardingSeen) {
      setCloudOnboardingOpen(true)
      return
    }
    updateSettings({ appMode: 'cloud' })
  }

  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label="Cloud"
      title={on
        ? "Cloud mode is on — chat, image and video run on LU's hosted GPUs. Click to go back to Local."
        : "Run LU on hosted GPUs with your lu-labs.ai account"}
      onClick={toggle}
      className={cn(
        'flex items-center gap-1.5 pl-2 pr-1.5 py-[3px] rounded-full border transition-colors',
        on
          ? 'border-[#7c3aed] bg-[#7c3aed]/10 text-[#7c3aed] dark:text-[#a78bfa]'
          : 'border-gray-200 dark:border-white/10 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-white/20',
      )}
    >
      <Cloud size={12} strokeWidth={on ? 2.25 : 1.75} className="shrink-0" />
      <span className="text-[0.65rem] font-medium leading-none">Cloud</span>
      <span
        aria-hidden
        className={cn(
          'relative w-[22px] h-[12px] rounded-full transition-colors shrink-0',
          on ? 'bg-[#7c3aed]' : 'bg-gray-300 dark:bg-white/15',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] w-[8px] h-[8px] rounded-full bg-white shadow-sm transition-[left]',
            on ? 'left-[12px]' : 'left-[2px]',
          )}
        />
      </span>
    </button>
  )
}
