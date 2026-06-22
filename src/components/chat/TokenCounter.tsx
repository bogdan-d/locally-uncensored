import { useChatStore } from '../../stores/chatStore'
import { estimateTokens } from '../../lib/context-compaction'
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

  // 100%-REAL usage: the latest assistant message's model-reported usage.
  // promptTokens already includes the system prompt, tools, RAG and the full
  // history, so totalTokens is the TRUE current context fill. The char/4
  // estimate is only a fallback until the first real reply lands.
  // The counter must not visibly "jump" between turns (David 2026-06-20: "3.5k
  // springt auf 1.9k", especially after an image/video gen). The model-reported
  // usage is the size of the COMPACTED prompt that turn — and that legitimately
  // swings: a turn that feeds the generated image back for vision costs ~3k, the
  // next turn (image trimmed by compaction, or a regenerate that reuses the prior
  // args) costs ~1k. Both are "real", so showing the latest made the bar bounce.
  // Use the conversation's HIGH-WATER real usage instead: it reflects the largest
  // context this chat has actually reached and never dips just because one turn
  // compacted harder. A live provisional estimate can still push it higher.
  const reversed = [...messages].reverse()
  const realMax = messages.reduce(
    (mx, m) => (m.usage && !m.usage.estimated && m.usage.totalTokens > mx ? m.usage.totalTokens : mx),
    0,
  )
  const lastUsage = reversed.find((m) => m.usage && m.usage.totalTokens > 0)?.usage
  const estimated = messages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content)
    if (m.thinking) tokens += estimateTokens(m.thinking)
    if (m.toolCallSummary) tokens += estimateTokens(m.toolCallSummary)
    tokens += 4 // role overhead
    return sum + tokens
  }, 0)
  const rawUsed = realMax > 0
    ? Math.max(realMax, lastUsage?.totalTokens ?? 0)
    : (lastUsage ? lastUsage.totalTokens : estimated)

  if (!activeConversationId || messages.length === 0) return null

  // Resolved real context window; fall back to the VRAM-safe default only while
  // the provider probe is still in flight (ctx not resolved yet).
  const maxTokens = ctx.contextWindow > 0 ? ctx.contextWindow : 16384
  // Cap the numerator at the active window. The anti-jump high-water (realMax)
  // is per-conversation, not per-model, so switching to a SMALLER-context model
  // mid-chat would otherwise pin the bar above 100% forever (e.g. a 20k chat on
  // an 8k model → "20k/8k" red). Showing "8.0k/8.0k" (full) is honest.
  const usedTokens = Math.min(rawUsed, maxTokens)
  // "Real" = the model reported it AND that exact number is what we're showing
  // (not capped down, no larger provisional estimate on top).
  const isReal = realMax > 0 && rawUsed === realMax && usedTokens === rawUsed

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
    ? `Context: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${source}) — real, reported by the model (includes system prompt + tools + RAG)`
    : lastUsage
      ? `Estimated: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${source}) — includes the system prompt + tools; the exact count lands when the model replies`
      : `Estimated: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${source}) — estimate until the first reply`

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
