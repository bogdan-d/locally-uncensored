/**
 * Context-fill computation for the TokenCounter.
 *
 * "Used" means: roughly what the NEXT request will send — that is the only
 * number worth alarming the user about. Two rules keep it honest:
 *
 * 1. Anchor on the newest model-reported usage when one exists. Its
 *    promptTokens is 100% real and already includes the system prompt, tools,
 *    RAG and the whole history up to that turn — things a char/4 estimate of
 *    the visible messages can never see.
 *
 * 2. Never count reasoning as context. `thinking` is stripped from outgoing
 *    requests (useChat sends role+content+images only), and completionTokens
 *    on a reasoning model is mostly hidden thinking. A looping cloud reasoner
 *    once burned its whole 16,384-token completion budget producing zero
 *    visible output; counting that (or high-watering totalTokens across the
 *    conversation, as this component used to) pinned the counter at "16.5k"
 *    forever while the next real prompt cost 65 tokens (David, 2026-07-12).
 *    Only the assistant's visible content joins future prompts, so only that
 *    is added on top of the anchor.
 */

import { estimateTokens } from './context-compaction'

export interface FillMessage {
  role: string
  content: string
  thinking?: string
  toolCallSummary?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    estimated?: boolean
  }
}

export interface ContextFill {
  /** Estimated tokens the next request will carry. */
  used: number
  /** True when `used` is anchored on a non-estimated, model-reported usage. */
  real: boolean
}

/** Visible size of one message in a future prompt (content only, no thinking). */
function visibleTokens(m: FillMessage): number {
  let t = estimateTokens(m.content)
  if (m.toolCallSummary) t += estimateTokens(m.toolCallSummary)
  return t + 4 // role overhead
}

export function computeContextFill(messages: FillMessage[]): ContextFill {
  // Newest message carrying usage (assistant turns store it when the model
  // reports real counts; the agent path stores a provisional estimated one).
  let anchorIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i].usage
    if (u && u.totalTokens > 0) { anchorIdx = i; break }
  }

  if (anchorIdx === -1) {
    // No usage anywhere yet — plain estimate over the visible conversation.
    return { used: messages.reduce((sum, m) => sum + visibleTokens(m), 0), real: false }
  }

  const anchor = messages[anchorIdx].usage!
  // promptTokens covers everything UP TO that turn's input; the anchored
  // message's own visible reply + every later message joins the next prompt.
  let used = anchor.promptTokens
  for (let i = anchorIdx; i < messages.length; i++) {
    used += visibleTokens(messages[i])
  }
  return { used, real: !anchor.estimated }
}
