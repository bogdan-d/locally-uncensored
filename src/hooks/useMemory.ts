/**
 * useMemory — Hook for memory operations including LLM-based auto-extraction.
 *
 * Fires a separate inference call to analyze conversation exchanges and
 * extract memorable information. Errors are caught silently — extraction
 * failures must never disrupt the chat experience.
 */

import { useCallback } from 'react'
import { useMemoryStore } from '../stores/memoryStore'
import { useModelStore } from '../stores/modelStore'
import { useProviderStore } from '../stores/providerStore'
import { getProviderForModel } from '../api/providers'
import { buildExtractionPrompt, parseExtractionResponse } from '../lib/memory-extraction'

// Rate limit: only extract every Nth turn to reduce cost
let _extractCounter = 0
const EXTRACT_EVERY_N = 3
const MIN_RESPONSE_LENGTH = 100

/**
 * Pure extraction routine — safe to call from anywhere (hooks, Tauri listeners,
 * background jobs). Fire-and-forget: never throws, errors are swallowed.
 *
 * Used by:
 *  - useMemory().extractAndSave (LU chat)
 *  - useAgentChat (agent loop)
 *  - useCodex (codex loop)
 *  - AppShell.tsx remote-chat-message listener (Remote chats)
 */
export async function extractMemoriesFromPair(
  userMessage: string,
  assistantResponse: string,
  conversationId: string
): Promise<void> {
  try {
    const { activeModel } = useModelStore.getState()
    if (!activeModel) return

    const memState = useMemoryStore.getState()
    if (!memState.settings.autoExtractEnabled) return

    // Skip short responses (not enough signal to extract)
    if (assistantResponse.length < MIN_RESPONSE_LENGTH) return

    // Rate limit: only extract every Nth turn
    _extractCounter++
    if (_extractCounter % EXTRACT_EVERY_N !== 0) return

    // Warn-check: if cloud provider, check if user has opted in
    const providerState = useProviderStore.getState()
    const isCloud = (providerState.providers.openai.enabled && !providerState.providers.openai.isLocal) ||
      providerState.providers.anthropic.enabled
    if (isCloud && !memState.settings.autoExtractInAllModes) return

    // Build summary of existing memories to prevent duplicates
    const existingSummary = memState.entries
      .slice(-20)
      .map(e => `- [${e.type}] ${e.title}`)
      .join('\n')

    const messages = buildExtractionPrompt(userMessage, assistantResponse, existingSummary)

    // Use active provider for extraction call
    const { provider, modelId } = getProviderForModel(activeModel)

    // Collect full response via streaming
    let fullResponse = ''
    const stream = provider.chatStream(modelId, messages, {
      temperature: 0.1,
      maxTokens: 500,
    })

    for await (const chunk of stream) {
      if (chunk.content) fullResponse += chunk.content
      if (chunk.done) break
    }

    // Parse and save
    const result = parseExtractionResponse(fullResponse)
    if (result.shouldSave) {
      for (const memory of result.memories) {
        memState.addMemory({
          type: memory.type,
          title: memory.title,
          description: memory.description,
          content: memory.content,
          tags: memory.tags,
          source: conversationId,
        })
      }
    }
  } catch {
    // Extraction failures are non-critical — silently swallowed
  }
}

export function useMemory() {
  /**
   * Fire-and-forget extraction: asks the active LLM to analyze a conversation
   * exchange and save any extracted memories. Rate-limited to every 3rd turn
   * and skips short responses.
   */
  const extractAndSave = useCallback(extractMemoriesFromPair, [])

  return { extractAndSave }
}
