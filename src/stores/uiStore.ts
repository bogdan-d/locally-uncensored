import { create } from 'zustand'

export type View = 'chat' | 'models' | 'settings' | 'create' | 'benchmark'

/** Which Cloud teaser sheet is open (Local-mode discovery, 2.5.8).
 *  'intent' = a locked Create tab (the cloud-only intents incl. the five
 *  2.5.8 categories); 'create-model' = a hosted model row in the Create
 *  picker (modelId = the tapped catalog id). The chat picker's Cloud rows
 *  open the CloudGateModal directly — no sheet there. */
export type CloudTeaserTarget =
  | {
      surface: 'intent'
      intent: 'upscale' | 'eraser' | 'character' | 'lipsync' | 'music' | 'extend' | 'motion'
    }
  | { surface: 'create-model'; kind: 'image' | 'video'; modelId: string }

interface UIState {
  currentView: View
  sidebarOpen: boolean
  /** CloudGateModal (login → plan → beta gate) — opened by the header's
   *  Cloud switch when the cloud side isn't usable yet. */
  cloudGateOpen: boolean
  /** One-time Cloud onboarding — opened on the first successful flip to
   *  Cloud (subscription present, cloudOnboardingSeen still false). */
  cloudOnboardingOpen: boolean
  /** CloudTeaserModal — null = closed. */
  cloudTeaser: CloudTeaserTarget | null
  setView: (view: View) => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setCloudGateOpen: (open: boolean) => void
  setCloudOnboardingOpen: (open: boolean) => void
  setCloudTeaser: (target: CloudTeaserTarget | null) => void
}

export const useUIStore = create<UIState>()((set) => ({
  currentView: 'chat',
  sidebarOpen: true,
  cloudGateOpen: false,
  cloudOnboardingOpen: false,
  cloudTeaser: null,

  // Sidebar visibility follows the view: it's the conversation list, which
  // only makes sense in Chat. The hamburger toggle still works on other views;
  // it just resets to the view's default on the next setView() call.
  setView: (view) => set({ currentView: view, sidebarOpen: view === 'chat' }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setCloudGateOpen: (open) => set({ cloudGateOpen: open }),
  setCloudOnboardingOpen: (open) => set({ cloudOnboardingOpen: open }),
  setCloudTeaser: (target) => set({ cloudTeaser: target }),
}))
