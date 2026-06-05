import { useState, useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { estimateTokens, getModelMaxTokens } from '../../lib/context-compaction'
import { effectiveContextWindow } from '../../lib/context-window'

export function TokenCounter() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const activeModel = useModelStore((s) => s.activeModel)
  // Settings override — when the user bumps maxTokens in Settings the counter
  // should reflect that immediately, not just on next model switch. Bug #4
  // (phantomderp v2.4.3): the bar stayed pinned to the model's default
  // (e.g. 8.2k) even after the user moved the slider to 16384. Subscribing
  // to the settings store fixes the staleness — `useSettingsStore` re-renders
  // any consumer on every settings update.
  // Context-window override (num_ctx), NOT maxTokens (that's the output limit
  // num_predict — using it as the denominator was a long-standing mismatch).
  const contextOverride = useSettingsStore((s) => s.settings.contextWindowOverride)
  const [modelMaxTokens, setModelMaxTokens] = useState<number>(4096)

  const conversation = conversations.find((c) => c.id === activeConversationId)
  const messages = conversation?.messages || []

  // 100%-REAL usage: the latest assistant message's model-reported usage.
  // promptTokens already includes the system prompt, tools, RAG and the full
  // history, so totalTokens is the TRUE current context fill. The char/4
  // estimate is only a fallback until the first real reply lands.
  const lastUsage = [...messages].reverse().find((m) => m.usage && m.usage.totalTokens > 0)?.usage
  const estimated = messages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content)
    if (m.thinking) tokens += estimateTokens(m.thinking)
    if (m.toolCallSummary) tokens += estimateTokens(m.toolCallSummary)
    tokens += 4 // role overhead
    return sum + tokens
  }, 0)
  const usedTokens = lastUsage ? lastUsage.totalTokens : estimated
  const isReal = !!lastUsage

  // Fetch max tokens when model changes — only the model-side default is
  // cached here; the user override is read live from the settings store.
  useEffect(() => {
    if (!activeModel) return
    getModelMaxTokens(activeModel).then(setModelMaxTokens).catch(() => setModelMaxTokens(4096))
  }, [activeModel])

  if (!activeConversationId || messages.length === 0) return null

  // Denominator = the context window we actually send to the model (num_ctx):
  // the override if set, else the model's real context capped for VRAM safety.
  // Same formula the Ollama provider uses, so display and reality can't drift.
  const maxTokens = effectiveContextWindow(modelMaxTokens, contextOverride)

  const ratio = maxTokens > 0 ? usedTokens / maxTokens : 0
  const color = ratio > 0.8 ? 'text-red-400' : ratio > 0.5 ? 'text-amber-400' : 'text-gray-500'
  const barColor = ratio > 0.8 ? 'bg-red-500' : ratio > 0.5 ? 'bg-amber-500' : 'bg-gray-500'

  const formatK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  const title = isReal
    ? `Context: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (num_ctx) — real, reported by the model (includes system prompt + tools + RAG)`
    : `Estimated: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (num_ctx) — estimate until the first reply`

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 ${color}`} title={title}>
      <div className="w-12 h-1 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${Math.min(ratio * 100, 100)}%` }}
        />
      </div>
      <span className="text-[0.55rem] font-mono tabular-nums">
        {formatK(usedTokens)}/{formatK(maxTokens)}
      </span>
    </div>
  )
}
