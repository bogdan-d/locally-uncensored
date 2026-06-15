import { create } from 'zustand'

/**
 * Ephemeral per-conversation "a turn is generating" flags. Deliberately NOT
 * persisted — a crash mid-stream must never leave a stale "running" marker that
 * survives a restart.
 *
 * Why this exists (David 2026-06-12): the chat / agent / codex hooks each held a
 * single GLOBAL `isGenerating` boolean. The typing indicator (the 3 dots) and
 * the realtime counter were gated on that global, so generating in ONE chat lit
 * the dots in EVERY other chat you switched to ("die drei ladepunkte kommen in
 * vorherigen chats auch"). Binding the indicators to the conversation that is
 * actually generating fixes it — the dots show only in the chat whose turn is
 * in flight. The Coding Agent uses its own per-thread status (codexStore), so it
 * doesn't need this store; Chat + Agent (which share one useChat instance) do.
 *
 * The input's generating state stays GLOBAL on purpose: the chat hook reuses
 * shared streaming refs, so allowing a second concurrent send from another chat
 * would corrupt both streams. Only the visual indicators move per-conversation.
 */
interface GenerationState {
  /** conversationId → true while its turn is generating. Absent = idle. */
  generating: Record<string, boolean>
  setGenerating: (conversationId: string | null | undefined, on: boolean) => void
}

export const useGenerationStore = create<GenerationState>((set) => ({
  generating: {},
  setGenerating: (conversationId, on) =>
    set((state) => {
      if (!conversationId) return state
      // No-op when the flag is already in the requested state — avoids an
      // unnecessary store update (and re-render) on every stream tick.
      if (!!state.generating[conversationId] === on) return state
      const next = { ...state.generating }
      if (on) next[conversationId] = true
      else delete next[conversationId]
      return { generating: next }
    }),
}))
