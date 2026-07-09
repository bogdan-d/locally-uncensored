// The global Local/Cloud switch (header, brand cluster). Flipping to Cloud
// only succeeds when the whole cloud axis is usable (signed in + licensed +
// beta gate + credit budget) — otherwise it opens the CloudGateModal, which
// flips the mode itself once the account clears. Flipping to Local always
// works. Everything mode-dependent (chat picker, Create backend, hidden
// local-hardware tabs) hangs off settings.appMode.

import { HardDrive, Cloud } from 'lucide-react'
import { Segmented } from '../create/ui/Segmented'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { useCloudAuthStore, deriveCloudAvailable } from '../../stores/cloudAuthStore'
import type { AppMode } from '../../types/settings'

export function ModeSwitch() {
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const setCloudGateOpen = useUIStore((s) => s.setCloudGateOpen)
  const available = useCloudAuthStore(deriveCloudAvailable)

  const change = (mode: AppMode) => {
    if (mode === appMode) return
    if (mode === 'cloud' && !available) {
      setCloudGateOpen(true)
      return
    }
    updateSettings({ appMode: mode })
  }

  return (
    <Segmented<AppMode>
      size="sm"
      layoutId="app-mode"
      ariaLabel="Local or Cloud mode"
      value={appMode}
      onChange={change}
      options={[
        { value: 'local', label: 'Local', icon: HardDrive, title: 'Run everything on this machine' },
        { value: 'cloud', label: 'Cloud', icon: Cloud, title: "Run on LU's hosted GPUs (lu-labs.ai account)" },
      ]}
    />
  )
}
