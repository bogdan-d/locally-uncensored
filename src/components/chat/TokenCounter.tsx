import { useChatStore } from '../../stores/chatStore'
import { computeContextFill } from '../../lib/token-usage'
import { useActiveContextWindow } from '../../hooks/useActiveContextWindow'

export function TokenCounter() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)

  // The denominator is the REAL context window the active model runs with —
  // provider-aware and shared with the Context dropdown so the two never drift
  // (David: "muss immer stimmen"). Ollama = the num_ctx we send; LM Studio =
  // loaded_context_length (what it actually loaded), NOT the model's max.
  const ctx = useActiveContextWindow()

  const conversation = conversations.find((c) => c.id === activeConversationId)
  const messages = conversation?.messages || []

  // Context fill = what the NEXT request will roughly send, anchored on the
  // newest model-reported usage (real promptTokens include system prompt +
  // tools + RAG + history) plus the visible messages after it. Reasoning
  // (`thinking`) is never resent, so it is never counted — the old
  // conversation-high-water over totalTokens pinned this counter at "16.5k"
  // forever after one looping cloud reasoner burned its whole 16,384-token
  // completion budget, while the next real prompt cost 65 tokens (David,
  // 2026-07-12). An honest dip after compaction beats a sticky wrong maximum.
  const fill = computeContextFill(messages)
  const rawUsed = fill.used

  if (!activeConversationId || messages.length === 0) return null

  // Resolved real context window; fall back to the VRAM-safe default only while
  // the provider probe is still in flight (ctx not resolved yet).
  const maxTokens = ctx.contextWindow > 0 ? ctx.contextWindow : 16384
  // Cap the numerator at the active window: a long chat carried onto a
  // smaller-context model shows "8.0k/8.0k" (full), not "20k/8k".
  const usedTokens = Math.min(rawUsed, maxTokens)
  // "Real" = anchored on a non-estimated model report and shown uncapped.
  const isReal = fill.real && usedTokens === rawUsed

  const ratio = maxTokens > 0 ? usedTokens / maxTokens : 0
  const color = ratio > 0.8 ? 'text-red-400' : ratio > 0.5 ? 'text-amber-400' : 'text-gray-500'
  const barColor = ratio > 0.8 ? 'bg-red-500' : ratio > 0.5 ? 'bg-amber-500' : 'bg-gray-500'

  const formatK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  const source = ctx.provider === 'lmstudio'
    ? "LM Studio loaded context"
    : ctx.provider === 'ollama'
      ? 'Ollama num_ctx'
      : 'model context'
  const title = isReal
    ? `Context: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${source}) — anchored on the model's last reported usage (includes system prompt + tools + RAG); reasoning tokens are not context and aren't counted`
    : `Estimated: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${source}) — estimate until the model reports real usage`

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
