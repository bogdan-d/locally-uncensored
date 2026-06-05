import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Settings, Persona } from '../types/settings'
import { DEFAULT_SETTINGS, BUILT_IN_PERSONAS } from '../lib/constants'

// v5 (Feature EE v2.5.0): added settings.exclusiveVramMode. The migrate below
// already merges { ...DEFAULT_SETTINGS, ...persisted.settings }, so bumping the
// version is all that's needed — the new default fills in while every existing
// user value is preserved. Rehydration is NOT broken: a persisted v4 blob runs
// the same merge path that has handled every prior additive field.
// v6 (uselu design port): added settings.personasEnabled (master persona
// switch, default true). Bumped so existing users get the default ON instead
// of an undefined → falsy "personas off" surprise.
const STORE_VERSION = 6

interface SettingsState {
  settings: Settings
  personas: Persona[]
  activePersonaId: string
  _version: number
  updateSettings: (partial: Partial<Settings>) => void
  resetSettings: () => void
  addPersona: (persona: Persona) => void
  removePersona: (id: string) => void
  updatePersona: (id: string, partial: Partial<Persona>) => void
  setActivePersona: (id: string) => void
  getActivePersona: () => Persona | undefined
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      personas: BUILT_IN_PERSONAS,
      activePersonaId: 'unrestricted',
      _version: STORE_VERSION,

      updateSettings: (partial) =>
        set((state) => ({ settings: { ...state.settings, ...partial } })),

      resetSettings: () => set((state) => ({ settings: { ...DEFAULT_SETTINGS, onboardingDone: state.settings.onboardingDone } })),

      addPersona: (persona) =>
        set((state) => ({ personas: [...state.personas, persona] })),

      removePersona: (id) =>
        set((state) => ({
          personas: state.personas.filter((p) => p.id !== id),
          activePersonaId: state.activePersonaId === id ? 'unrestricted' : state.activePersonaId,
        })),

      updatePersona: (id, partial) =>
        set((state) => ({
          personas: state.personas.map((p) => (p.id === id ? { ...p, ...partial } : p)),
        })),

      setActivePersona: (id) => set({ activePersonaId: id }),

      getActivePersona: () => {
        const { personas, activePersonaId } = get()
        return personas.find((p) => p.id === activePersonaId)
      },
    }),
    {
      name: 'chat-settings',
      version: STORE_VERSION,
      migrate: (persisted: any, version: number) => {
        if (version < STORE_VERSION) {
          const customPersonas = (persisted.personas || []).filter((p: Persona) => !p.isBuiltIn)
          return {
            ...persisted,
            // Merge new default settings into existing (fills missing fields like thinkingEnabled)
            settings: { ...DEFAULT_SETTINGS, ...(persisted.settings || {}) },
            personas: [...BUILT_IN_PERSONAS, ...customPersonas],
            activePersonaId: persisted.activePersonaId || 'unrestricted',
            _version: STORE_VERSION,
          }
        }
        return persisted
      },
    }
  )
)
