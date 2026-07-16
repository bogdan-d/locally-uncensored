// Auto-read bridge (#77). Lets non-voice hooks (useChat / useAgentChat, on turn
// completion) trigger the SAME TTS ladder the Speaker button uses, WITHOUT
// calling useVoice() themselves — useVoice subscribes to the voice store whose
// `isSpeaking` flips during playback, and a chat hook must not re-render on that.
//
// useVoice registers its current streaming-speak fn; the always-mounted mic
// VoiceButton keeps it refreshed on every voice-state change, so `current`
// tracks the live voice settings. Callers gate on `ttsEnabled && autoReadAloud`
// (read via getState(), non-reactive) before invoking.
let current: ((text: string) => void) | null = null

export function registerAutoSpeak(fn: (text: string) => void): void {
  current = fn
}

export function autoSpeak(text: string): void {
  current?.(text)
}
