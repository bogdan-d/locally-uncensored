import { useState, useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { estimateTokens, getModelMaxTokens } from '../../lib/context-compaction'

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
  const settingsMaxTokens = useSettingsStore((s) => s.settings.maxTokens)
  const [modelMaxTokens, setModelMaxTokens] = useState<number>(4096)

  const conversation = conversations.find((c) => c.id === activeConversationId)
  const messages = conversation?.messages || []

  // Estimate used tokens from all messages
  const usedTokens = messages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content)
    if (m.thinking) tokens += estimateTokens(m.thinking)
    if (m.toolCallSummary) tokens += estimateTokens(m.toolCallSummary)
    tokens += 4 // role overhead
    return sum + tokens
  }, 0)

  // Fetch max tokens when model changes — only the model-side default is
  // cached here; the user override is read live from the settings store.
  useEffect(() => {
    if (!activeModel) return
    getModelMaxTokens(activeModel).then(setModelMaxTokens).catch(() => setModelMaxTokens(4096))
  }, [activeModel])

  if (!activeConversationId || messages.length === 0) return null

  // Effective ceiling: user-set maxTokens wins if non-zero (the slider's "0"
  // default means "use whatever the model reports").
  const maxTokens = settingsMaxTokens > 0 ? settingsMaxTokens : modelMaxTokens

  const ratio = maxTokens > 0 ? usedTokens / maxTokens : 0
  const color = ratio > 0.8 ? 'text-red-400' : ratio > 0.5 ? 'text-amber-400' : 'text-gray-500'
  const barColor = ratio > 0.8 ? 'bg-red-500' : ratio > 0.5 ? 'bg-amber-500' : 'bg-gray-500'

  const formatK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  const isOverride = settingsMaxTokens > 0 && settingsMaxTokens !== modelMaxTokens
  const title = isOverride
    ? `Estimated: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (Settings override — model default is ${modelMaxTokens.toLocaleString()})`
    : `Estimated: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`

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
