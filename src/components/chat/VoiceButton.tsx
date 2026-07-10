import { useEffect, useRef } from "react"
import { motion } from "framer-motion"
import { Mic, MicOff, Loader2 } from "lucide-react"
import { useVoice } from "../../hooks/useVoice"
import { useVoiceStore } from "../../stores/voiceStore"

interface Props {
  onTranscript: (text: string) => void
  /** Live interim transcript while recording (streaming dictation). */
  onInterim?: (text: string) => void
  onRecordingChange?: (isRecording: boolean) => void
  disabled?: boolean
}

export function VoiceButton({ onTranscript, onInterim, onRecordingChange, disabled }: Props) {
  const { isRecording, isTranscribing, sttSupported, sttError, clearSttError, startRecording, stopRecording, recheckStt, maxRecordingMs } = useVoice()
  // Auto-stop timer for cloud dictation — the transcribe route rejects takes
  // past ~6.5 min (12 MiB) with a 413 that loses the WHOLE recording, so the
  // take is stopped and transcribed just under the cap instead.
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasRecordingRef = useRef(false)

  useEffect(() => {
    // The startup probe (App.tsx) can run before the persistent Whisper server
    // has finished loading its model. If STT still reads unavailable when the
    // mic mounts, do one fresh probe so a late-ready server lights it up.
    if (!sttSupported) void recheckStt()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dictation failures (cloud 401/403/413/429/5xx, dead mic) surface as a
  // transient bubble over the mic instead of the take silently vanishing.
  useEffect(() => {
    if (!sttError) return
    const t = setTimeout(() => clearSttError(), 6000)
    return () => clearTimeout(t)
  }, [sttError, clearSttError])

  // Recording can end outside handleClick (close-to-tray teardown, unmount
  // recovery) — mirror the transition to the composer so "Recording…" never
  // sticks, and drop a pending auto-stop timer so it can't fire on a dead take.
  useEffect(() => {
    if (wasRecordingRef.current && !isRecording) {
      if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null }
      onRecordingChange?.(false)
    }
    wasRecordingRef.current = isRecording
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording])

  useEffect(() => () => { if (autoStopRef.current) clearTimeout(autoStopRef.current) }, [])

  const finishRecording = async () => {
    if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null }
    onRecordingChange?.(false)
    const transcript = await stopRecording()
    if (transcript.trim()) {
      onTranscript(transcript.trim())
    }
  }

  const handleClick = async () => {
    if (disabled || isTranscribing) return

    if (isRecording) {
      await finishRecording()
    } else {
      onRecordingChange?.(true)
      const ok = await startRecording((interim) => onInterim?.(interim))
      // Roll back the composer's "Recording…" state when the mic never
      // started (permission denied / no input device) — otherwise Enter-to-
      // send stays blocked with no recovery path.
      if (!ok) {
        onRecordingChange?.(false)
        return
      }
      if (maxRecordingMs) {
        autoStopRef.current = setTimeout(() => {
          autoStopRef.current = null
          if (!useVoiceStore.getState().isRecording) return
          useVoiceStore.getState().setSttError("Dictation limit reached — transcribing what was recorded so far")
          void finishRecording()
        }, maxRecordingMs)
      }
    }
  }

  if (!sttSupported) {
    return (
      <div className="relative group/mic">
        <button
          disabled
          className="p-1.5 rounded-lg text-gray-300 dark:text-gray-600 cursor-not-allowed shrink-0"
          aria-label="Microphone unavailable"
        >
          <MicOff size={14} />
        </button>
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-800 dark:bg-gray-700 text-white text-[0.6rem] rounded whitespace-nowrap opacity-0 group-hover/mic:opacity-100 transition-opacity pointer-events-none">
          Speech-to-text off — enable it in Settings → Voice &amp; Remote
        </div>
      </div>
    )
  }

  // Transcribing state — show spinner
  if (isTranscribing) {
    return (
      <motion.button
        disabled
        className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-500/20 border border-blue-300 dark:border-blue-500/40 text-blue-600 dark:text-blue-400 shrink-0 relative"
        aria-label="Transcribing audio"
      >
        <Loader2 size={14} className="animate-spin" />
      </motion.button>
    )
  }

  return (
    <div className="relative shrink-0">
      <motion.button
        onClick={handleClick}
        disabled={disabled}
        className={`p-1.5 rounded-lg transition-all shrink-0 relative ${
          isRecording
            ? "bg-red-100 dark:bg-red-500/20 border border-red-300 dark:border-red-500/40 text-red-600 dark:text-red-400"
            : "hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
        } disabled:opacity-30 disabled:cursor-not-allowed`}
        data-voice-button
        whileTap={{ scale: 0.9 }}
        aria-label={isRecording ? "Stop recording" : "Start voice input"}
      >
        {isRecording && (
          <motion.span
            className="absolute inset-0 rounded-lg border-2 border-red-500 dark:border-red-400"
            animate={{ scale: [1, 1.15, 1], opacity: [1, 0.4, 1] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
        <Mic size={14} />
      </motion.button>
      {sttError && (
        <div
          role="alert"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 w-max max-w-[240px] bg-red-600/95 dark:bg-red-500/90 text-white text-[0.6rem] leading-snug rounded text-center pointer-events-none z-10"
        >
          {sttError}
        </div>
      )}
    </div>
  )
}
