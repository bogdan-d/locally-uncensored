export type SearchProvider = 'auto' | 'brave' | 'tavily'

export type CavemanMode = 'off' | 'lite' | 'full' | 'ultra'

export interface Settings {
  apiEndpoint: string
  temperature: number
  topP: number
  topK: number
  maxTokens: number
  theme: 'light' | 'dark'
  onboardingDone: boolean
  thinkingEnabled: boolean
  cavemanMode: CavemanMode
  searchProvider: SearchProvider
  braveApiKey: string
  tavilyApiKey: string
  // Claude Code
  claudeCodeModel: string
  claudeCodeAutoApprove: boolean
  claudeCodePath: string
  // Agent budget (Phase 10 v2.4.0) — hard caps that halt a runaway agent.
  /** Hard cap on tool calls per user turn. 0 = unlimited (not recommended). */
  agentMaxToolCalls: number
  /** Hard cap on ReAct loop iterations per user turn. 0 = unlimited. */
  agentMaxIterations: number
  /** Override for the HuggingFace GGUF download directory. Empty = auto-detect from active openai-compat provider (e.g. LM Studio models folder). */
  hfDownloadPathOverride: string
  // Generation timeouts (Bug P v2.4.7 — ake0n_official Discord 2026-05-19,
  // Intel UHD CPU-only setup hit the 20-min cap at sampling 9/25 on a 1024px
  // Juggernaut-XL gen).
  /** Image generation timeout in minutes. Default 20. */
  imageGenTimeoutMinutes: number
  /** Video generation timeout in minutes. Default 60. */
  videoGenTimeoutMinutes: number
}

export interface Persona {
  id: string
  name: string
  icon: string
  systemPrompt: string
  isBuiltIn: boolean
}

// Voice settings (sttEnabled, ttsEnabled, ttsVoice, ttsRate, ttsPitch,
// autoSendOnTranscribe) are managed in src/stores/voiceStore.ts via
// the dedicated Zustand voice store with persistence.
