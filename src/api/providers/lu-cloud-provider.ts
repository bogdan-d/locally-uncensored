/**
 * LU Cloud Provider — OpenAI-compatible chat through the lu-labs.ai
 * confidential-inference proxy (`/api/inference/v1`).
 *
 * Thin composition over OpenAIProvider: the only difference is auth — the
 * bearer is the user's short-lived Supabase access token, refreshed per call
 * via getAccessToken(), never a static apiKey from the provider store.
 */

import type {
  ProviderClient, ProviderModel, ProviderConfig, ChatMessage, ChatOptions,
  ChatStreamChunk, ToolCall, ToolDefinition,
} from './types'
import { ProviderError } from './types'
import { OpenAIProvider } from './openai-provider'
import { getAccessToken } from '../cloud/supabase'

export class LuCloudProvider implements ProviderClient {
  readonly id = 'lu-cloud' as const
  private config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  // Fresh delegate per call: the token rotates (~1 h), and OpenAIProvider
  // reads apiKey from its config. isLocal:false keeps it off the Rust proxy.
  private async delegate(): Promise<OpenAIProvider> {
    let token: string | null
    try {
      token = await getAccessToken()
    } catch (e) {
      throw new ProviderError(
        e instanceof Error ? e.message : 'LU Cloud unreachable — check your connection.',
        'lu-cloud',
        'network',
      )
    }
    if (!token) {
      throw new ProviderError('Sign in to your LU Cloud account to chat in the cloud.', 'lu-cloud', 'auth', 401)
    }
    return new OpenAIProvider({ ...this.config, apiKey: token, isLocal: false })
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    const inner = await this.delegate()
    yield* inner.chatStream(model, messages, options)
  }

  async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<{ content: string; toolCalls: ToolCall[]; promptEvalCount?: number; evalCount?: number }> {
    const inner = await this.delegate()
    return inner.chatWithTools(model, messages, tools, options)
  }

  async listModels(): Promise<ProviderModel[]> {
    const inner = await this.delegate()
    const models = await inner.listModels()
    // Rebrand: the delegate reports provider 'openai' — these are LU Cloud.
    return models.map((m) => ({ ...m, provider: this.id, providerName: 'LU Cloud' }))
  }

  async checkConnection(): Promise<boolean> {
    try {
      const inner = await this.delegate()
      return await inner.checkConnection()
    } catch {
      return false
    }
  }

  async getContextLength(model: string): Promise<number> {
    const inner = await this.delegate()
    return inner.getContextLength(model)
  }
}
