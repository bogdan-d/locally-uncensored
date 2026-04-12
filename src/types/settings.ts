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
