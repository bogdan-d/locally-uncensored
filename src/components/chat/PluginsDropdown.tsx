import { useState } from 'react'
import { Plug, ChevronDown, Bone, User } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import type { CavemanMode } from '../../types/settings'

const CAVEMAN_MODES: { value: CavemanMode; label: string; desc: string }[] = [
  { value: 'off', label: 'Off', desc: 'Normal responses' },
  { value: 'lite', label: 'Lite', desc: 'Slightly shorter' },
  { value: 'full', label: 'Full', desc: 'Very terse' },
  { value: 'ultra', label: 'Ultra', desc: 'Maximum brevity' },
]

export function PluginsDropdown() {
  const [open, setOpen] = useState(false)
  const [cavemanOpen, setCavemanOpen] = useState(false)
  const [personaOpen, setPersonaOpen] = useState(false)
  const { getActivePersona, setActivePersona } = useSettingsStore()
  const activePersona = getActivePersona()
  const allPersonas = useSettingsStore((s) => s.personas)
  const cavemanMode = useSettingsStore((s) => s.settings.cavemanMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const isCavemanActive = cavemanMode && cavemanMode !== 'off'
  const isPersonaActive = activePersona && activePersona.id !== 'unrestricted'
  const currentCaveman = CAVEMAN_MODES.find((m) => m.value === (cavemanMode || 'off'))

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-0.5 rounded border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500 transition-colors text-[0.55rem]"
      >
        <Plug size={10} />
        <span>Plugins</span>
        {(isCavemanActive || isPersonaActive) && (
          <div className="flex gap-0.5">
            {isCavemanActive && <div className="w-1 h-1 rounded-full bg-amber-400" />}
            {isPersonaActive && <div className="w-1 h-1 rounded-full bg-green-400" />}
          </div>
        )}
        <ChevronDown size={8} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl py-1.5">

            {/* ── Caveman Mode Dropdown ───────────────────── */}
            <div className="px-2.5">
              <button
                onClick={() => { setCavemanOpen(!cavemanOpen); setPersonaOpen(false) }}
                className="w-full flex items-center justify-between py-1.5 group"
              >
                <div className="flex items-center gap-1.5">
                  <Bone size={10} className={isCavemanActive ? 'text-amber-400' : 'text-gray-400'} />
                  <span className="text-[0.6rem] font-medium text-gray-600 dark:text-gray-300">Caveman Mode</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className={`text-[0.55rem] ${isCavemanActive ? 'text-amber-400' : 'text-gray-500'}`}>
                    {currentCaveman?.label || 'Off'}
                  </span>
                  <ChevronDown size={9} className={`text-gray-500 transition-transform ${cavemanOpen ? 'rotate-180' : ''}`} />
                </div>
              </button>

              {cavemanOpen && (
                <div className="pb-1.5 space-y-0.5">
                  {CAVEMAN_MODES.map((mode) => {
                    const isActive = (cavemanMode || 'off') === mode.value
                    return (
                      <button
                        key={mode.value}
                        onClick={() => { updateSettings({ cavemanMode: mode.value }); setCavemanOpen(false) }}
                        className={`w-full flex items-center justify-between px-2 py-1 rounded text-left transition-colors ${
                          isActive
                            ? mode.value === 'off'
                              ? 'bg-gray-100 dark:bg-white/[0.06] text-gray-700 dark:text-gray-200'
                              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                            : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-300'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          {isActive && <div className={`w-1 h-1 rounded-full shrink-0 ${mode.value === 'off' ? 'bg-gray-400' : 'bg-amber-400'}`} />}
                          <span className="text-[0.55rem] font-medium">{mode.label}</span>
                        </div>
                        <span className="text-[0.5rem] text-gray-400">{mode.desc}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-gray-200 dark:border-white/[0.06] my-1" />

            {/* ── Personas Dropdown ───────────────────────── */}
            <div className="px-2.5">
              <button
                onClick={() => { setPersonaOpen(!personaOpen); setCavemanOpen(false) }}
                className="w-full flex items-center justify-between py-1.5 group"
              >
                <div className="flex items-center gap-1.5">
                  <User size={10} className={isPersonaActive ? 'text-green-400' : 'text-gray-400'} />
                  <span className="text-[0.6rem] font-medium text-gray-600 dark:text-gray-300">Persona</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className={`text-[0.55rem] truncate max-w-[80px] ${isPersonaActive ? 'text-green-400' : 'text-gray-500'}`}>
                    {activePersona?.name || 'Unrestricted'}
                  </span>
                  <ChevronDown size={9} className={`text-gray-500 transition-transform ${personaOpen ? 'rotate-180' : ''}`} />
                </div>
              </button>

              {personaOpen && (
                <div className="pb-1.5 space-y-0.5 max-h-[180px] overflow-y-auto scrollbar-thin">
                  {allPersonas.map((p) => {
                    const isActive = p.id === activePersona?.id
                    return (
                      <button
                        key={p.id}
                        onClick={() => { setActivePersona(p.id); setPersonaOpen(false) }}
                        className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors ${
                          isActive
                            ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                            : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-300'
                        }`}
                      >
                        {isActive && <div className="w-1 h-1 rounded-full bg-green-400 shrink-0" />}
                        <span className="text-[0.55rem] font-medium">{p.name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

          </div>
        </>
      )}
    </div>
  )
}
