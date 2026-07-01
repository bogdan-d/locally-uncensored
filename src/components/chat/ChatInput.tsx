import { useState, useRef, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Send, Square, Paperclip, X, Brain, Terminal } from 'lucide-react'
import { matchAgentCommands, type AgentCommand } from '../../lib/agent-commands'
import { VoiceButton } from './VoiceButton'
import { useVoiceStore } from '../../stores/voiceStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModelStore } from '../../stores/modelStore'
import { isThinkingCompatible, isVisionCompatible } from '../../lib/model-compatibility'
import type { AgentToolCall } from '../../types/agent-mode'
import type { ImageAttachment } from '../../types/chat'

interface Props {
  onSend: (content: string, images?: ImageAttachment[]) => void
  onStop: () => void
  isGenerating: boolean
  pendingApproval?: AgentToolCall | null
  onApprove?: () => void
  onReject?: () => void
  disabled?: boolean
  /**
   * Enable the "/command" typeahead. Only the Coding Agent (Code view) sets this
   * — slash commands belong there, not in the normal chat (David 2026-06-12).
   */
  slashCommands?: boolean
  /**
   * Open the Documents (RAG) panel. The clip button is images-only; this lets the
   * composer point a user who tried to attach a PDF/doc to the right place
   * (GH #69 — a PDF was silently dropped and the model hallucinated it couldn't
   * receive attachments).
   */
  onAttachDocs?: () => void
}

function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const base64 = dataUrl.split(',')[1]
      resolve({ data: base64, mimeType: file.type || 'image/png', name: file.name })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function ChatInput({ onSend, onStop, isGenerating, pendingApproval, onApprove, onReject, disabled, slashCommands, onAttachDocs }: Props) {
  const [input, setInput] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  // Transient hint shown when a non-image file is attached. The clip + drop are
  // images-only; PDFs/Word/text belong in the Documents (RAG) panel (GH #69).
  const [docHint, setDocHint] = useState(false)
  const [isVoiceRecording, setIsVoiceRecording] = useState(false)
  // Slash-command autocomplete (v2.5.3). When the input is a lone "/token", show
  // the matching agent commands; ↑/↓ to move, Enter/Tab to pick, Esc to dismiss.
  const [cmdMenu, setCmdMenu] = useState<AgentCommand[]>([])
  const [cmdIndex, setCmdIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Text already in the box when dictation started. Interim + final transcripts
  // are written as base + transcript, so streaming chunks REPLACE (not stack)
  // and pre-typed text is never wiped.
  const dictationBaseRef = useRef('')
  const isTranscribing = useVoiceStore((s) => s.isTranscribing)
  const thinkingEnabled = useSettingsStore((s) => s.settings.thinkingEnabled)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const activeModel = useModelStore((s) => s.activeModel)
  const canThink = isThinkingCompatible(activeModel)
  const canSeeImages = isVisionCompatible(activeModel)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [input])

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const all = Array.from(files)
    const imageFiles = all.filter(f => f.type.startsWith('image/'))
    // A non-image file (PDF, Word, text, …) can't ride along as a chat image —
    // it belongs in the Documents panel (RAG) so the model can actually read it.
    // Silently dropping it made a user think their PDF attached when it didn't,
    // and the model then hallucinated that it "couldn't receive attachments"
    // (GH #69). Surface a hint pointing at the right place instead.
    if (imageFiles.length < all.length) setDocHint(true)
    if (imageFiles.length === 0) return
    const newImages = await Promise.all(imageFiles.map(fileToImageAttachment))
    setImages(prev => [...prev, ...newImages].slice(0, 5)) // max 5 images
  }, [])

  // Auto-dismiss the document hint after a few seconds.
  useEffect(() => {
    if (!docHint) return
    const t = setTimeout(() => setDocHint(false), 8000)
    return () => clearTimeout(t)
  }, [docHint])

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  // Write a dictation transcript (interim or final) into the input as
  // base + transcript, then resize the textarea. NEVER sends — the user
  // reviews and presses Send (David 2026-06-06).
  const applyDictation = (text: string) => {
    const base = dictationBaseRef.current
    const sep = base && !/\s$/.test(base) ? ' ' : ''
    setInput(base + sep + text)
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
      }
    })
  }

  // Synchronous double-fire guard (David 2026-06-20: "ok generiere jetzt" landed
  // twice in one chat). The `isGenerating` prop and the cleared input only update
  // on the NEXT render, so two Enter keydowns in the same tick (key-repeat / IME
  // / a held Enter) both pass the checks below and send the identical message
  // twice. A short monotonic lock closes that window.
  const sendLockRef = useRef(0)
  const handleSend = () => {
    const trimmed = input.trim()
    if ((!trimmed && images.length === 0) || isGenerating || disabled) return
    const now = Date.now()
    if (now - sendLockRef.current < 700) return
    sendLockRef.current = now
    onSend(trimmed || '(image)', images.length > 0 ? images : undefined)
    setInput('')
    setImages([])
    setCmdMenu([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  // Update the input + the slash-command typeahead together. The typeahead is
  // Coding-Agent-only — in the normal chat (slashCommands unset) "/foo" is just
  // text and no menu appears.
  const updateInput = (value: string) => {
    setInput(value)
    const matches = slashCommands ? matchAgentCommands(value) : []
    setCmdMenu(matches)
    setCmdIndex(0)
  }

  // Fill the input with the chosen command (trailing space so args can follow)
  // and dismiss the menu. The user then types any args and presses Enter.
  const pickCommand = (cmd: AgentCommand) => {
    setInput(`/${cmd.name} `)
    setCmdMenu([])
    setCmdIndex(0)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Slash-command menu navigation takes precedence while it's open.
    if (cmdMenu.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCmdIndex((i) => (i + 1) % cmdMenu.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCmdIndex((i) => (i - 1 + cmdMenu.length) % cmdMenu.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        pickCommand(cmdMenu[cmdIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCmdMenu([])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isVoiceRecording || isTranscribing) return
      handleSend()
    }
  }

  // Paste handler for clipboard images (Ctrl+V screenshots)
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageItems = Array.from(items).filter(item => item.type.startsWith('image/'))
    if (imageItems.length === 0) return
    e.preventDefault()
    const files = imageItems.map(item => item.getAsFile()).filter(Boolean) as File[]
    addFiles(files)
  }, [addFiles])

  // Drag & Drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer?.files?.length) {
      addFiles(e.dataTransfer.files)
    }
  }, [addFiles])

  return (
    <div className="px-3 pb-2 pt-1 w-full max-w-[70%] mx-auto">
      {/* Approval used to live here as a popup over the chat input.
          Per user feedback ("eventuell in den chat einarbeiten") it now
          renders INSIDE the pending tool-call block in MessageList, so
          the approve/reject buttons sit visually attached to the tool
          they belong to. ChatView owns the Enter/Esc keyboard layer. */}

      <div
        className={`relative flex flex-col rounded-lg border px-2.5 py-1 transition-colors ${
          isDragOver
            ? 'bg-blue-500/5 border-blue-500/30'
            : 'bg-gray-50 dark:bg-white/[0.03] border-gray-200 dark:border-white/[0.06]'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Slash-command autocomplete — floats above the composer */}
        {cmdMenu.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-1.5 z-50 max-h-64 overflow-y-auto scrollbar-thin rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1f1f1f] shadow-xl py-1">
            <div className="px-2.5 py-1 flex items-center gap-1 text-[0.5rem] uppercase tracking-widest text-gray-400 dark:text-gray-600">
              <Terminal size={9} /> Coding commands
            </div>
            {cmdMenu.map((cmd, i) => (
              <button
                key={cmd.name}
                onMouseDown={(e) => { e.preventDefault(); pickCommand(cmd) }}
                onMouseEnter={() => setCmdIndex(i)}
                className={`w-full text-left px-2.5 py-1 flex items-baseline gap-2 transition-colors ${
                  i === cmdIndex ? 'bg-gray-100 dark:bg-white/[0.07]' : 'hover:bg-gray-50 dark:hover:bg-white/[0.04]'
                }`}
              >
                <span className="text-[0.72rem] font-medium text-gray-800 dark:text-gray-100 shrink-0">/{cmd.name}</span>
                {cmd.argHint && <span className="text-[0.6rem] text-gray-400 dark:text-gray-500 shrink-0">{cmd.argHint}</span>}
                <span className="text-[0.6rem] text-gray-500 dark:text-gray-400 truncate ml-auto">{cmd.summary}</span>
              </button>
            ))}
          </div>
        )}

        {/* Non-image attach hint (GH #69) — the clip is images-only; PDFs, Word,
            and text files go through the Documents panel so the model can read them. */}
        {docHint && (
          <div className="flex items-center gap-2 mb-1.5 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/20 text-[0.62rem] text-amber-700 dark:text-amber-300">
            <span className="flex-1">The clip attaches images. To ask about a PDF, Word, or text file, add it in the Documents panel.</span>
            {onAttachDocs && (
              <button
                onMouseDown={(e) => { e.preventDefault(); setDocHint(false); onAttachDocs() }}
                className="shrink-0 px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 font-medium transition-colors"
              >
                Open Documents
              </button>
            )}
            <button
              onMouseDown={(e) => { e.preventDefault(); setDocHint(false) }}
              className="shrink-0 text-amber-600/70 hover:text-amber-700 dark:text-amber-400/70 dark:hover:text-amber-300"
              aria-label="Dismiss"
            >
              <X size={11} />
            </button>
          </div>
        )}

        {/* Image previews */}
        {images.length > 0 && (
          <div className="flex gap-1.5 mb-1.5 flex-wrap">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={img.name}
                  className="w-14 h-14 object-cover rounded-lg border border-white/10"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={8} />
                </button>
                <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[0.4rem] text-gray-300 text-center rounded-b-lg truncate px-0.5">
                  {img.name}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Vision hint — a text-only model can't read the attached image.
            Non-blocking (send still works); the runtime error is also mapped
            to friendly copy. gthvidsten, GH Discussion #67. */}
        {images.length > 0 && activeModel && !canSeeImages && (
          <div className="flex items-start gap-1.5 mb-1.5 px-1 text-[0.55rem] leading-relaxed text-amber-600 dark:text-amber-400">
            <span className="shrink-0">⚠</span>
            <span>This model can't read images. Switch to a vision model (Gemma 4, LLaVA, Qwen-VL) to use the attachment.</span>
          </div>
        )}

        {/* Input row */}
        <div className="flex items-end gap-2">
          {/* Clip button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isGenerating}
            className="p-1.5 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/5 disabled:opacity-20 transition-all shrink-0"
            title="Attach images — for PDFs and documents use the Documents panel"
          >
            <Paperclip size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
          />

          <VoiceButton
            // Streaming dictation: interim chunks arrive while talking, the final
            // transcript replaces them on stop — both via applyDictation, which
            // writes base + transcript and NEVER sends (user presses Send).
            onInterim={applyDictation}
            onTranscript={applyDictation}
            onRecordingChange={(r) => {
              if (r) dictationBaseRef.current = input
              setIsVoiceRecording(r)
            }}
            disabled={isGenerating}
          />

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => updateInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setCmdMenu([]), 120)}
            onPaste={handlePaste}
            placeholder={disabled ? "Unavailable" : isDragOver ? "Drop images here..." : isTranscribing ? "Transcribing..." : isVoiceRecording ? "Recording..." : "Message..."}
            disabled={disabled}
            rows={1}
            className="flex-1 bg-transparent resize-none text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none text-[0.75rem] leading-relaxed max-h-[200px] disabled:opacity-50 scrollbar-thin"
          />

          {/* Think toggle */}
          <button
            onClick={() => {
              if (canThink) updateSettings({ thinkingEnabled: !thinkingEnabled })
            }}
            className={`flex items-center gap-1 px-1.5 py-1.5 rounded-md transition-all shrink-0 text-[0.6rem] font-medium ${
              thinkingEnabled && canThink
                ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                : !canThink
                  ? 'text-gray-600 opacity-40 cursor-default'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
            }`}
            title={canThink ? (thinkingEnabled ? 'Thinking ON' : 'Thinking OFF') : 'Model does not support thinking'}
          >
            <Brain size={11} />
            <span>Think</span>
          </button>

          {isGenerating ? (
            <motion.button
              onClick={onStop}
              className="p-1.5 rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-all shrink-0"
              whileTap={{ scale: 0.9 }}
              aria-label="Stop generation"
            >
              <Square size={13} />
            </motion.button>
          ) : (
            <motion.button
              onClick={handleSend}
              disabled={(!input.trim() && images.length === 0) || isTranscribing}
              className="p-1.5 rounded-md bg-white/8 text-gray-300 hover:bg-white/12 disabled:opacity-20 disabled:cursor-not-allowed transition-all shrink-0"
              whileTap={{ scale: 0.9 }}
              aria-label="Send message"
            >
              <Send size={13} />
            </motion.button>
          )}
        </div>
      </div>
    </div>
  )
}
