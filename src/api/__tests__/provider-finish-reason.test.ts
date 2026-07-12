/**
 * finishReason + empty-reply plumbing tests (2026-07-12)
 *
 * A cloud reasoner (Qwen3.6 via LU Cloud) can burn its whole token budget
 * inside the reasoning channel and never emit an answer token — the stream
 * ends with finish_reason:"length" (or is cut by a proxy with no sentinel at
 * all). The provider must surface WHY generation ended so the chat layer can
 * explain the empty bubble instead of rendering silent dead air.
 *
 * Also covers: server-declared context_length from /models beating the name
 * heuristic in getContextLength (long-chat max_tokens starvation), Ollama
 * done_reason pass-through, and the widened THINKING_COMPATIBLE families.
 *
 * Run: npx vitest run src/api/__tests__/provider-finish-reason.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from '../providers/openai-provider'
import type { ProviderConfig, ChatStreamChunk } from '../providers/types'
import { isThinkingCompatible } from '../../lib/model-compatibility'

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openai',
    name: 'TestProvider',
    enabled: true,
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'test-key',
    isLocal: false,
    ...overrides,
  }
}

function sseResponse(events: string[]): Response {
  return new Response(events.map(e => `data: ${e}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function collect(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chatStream finishReason', () => {
  it("surfaces finish_reason 'length' on the done chunk (reasoning-only turn)", async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([
      '{"choices":[{"delta":{"reasoning_content":"thinking hard..."}}]}',
      '{"choices":[{"delta":{},"finish_reason":"length"}]}',
      '[DONE]',
    ]))

    const chunks = await collect(provider.chatStream('some-model', [{ role: 'user', content: 'hi' }]))
    const thinking = chunks.filter(c => c.thinking)
    const done = chunks.find(c => c.done)

    expect(thinking.length).toBe(1)
    expect(thinking[0].thinking).toBe('thinking hard...')
    expect(done?.finishReason).toBe('length')
    // No answer tokens ever arrived
    expect(chunks.some(c => c.content && !c.done)).toBe(false)
  })

  it("defaults to 'stop' when [DONE] arrives without an explicit finish_reason", async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([
      '{"choices":[{"delta":{"content":"42"}}]}',
      '[DONE]',
    ]))

    const chunks = await collect(provider.chatStream('some-model', [{ role: 'user', content: 'hi' }]))
    expect(chunks.find(c => c.done)?.finishReason).toBe('stop')
  })

  it("tags a cleanly-cut stream (no [DONE], no finish_reason) as 'disconnect'", async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([
      '{"choices":[{"delta":{"reasoning_content":"reasoning that never finishe"}}]}',
      // proxy idle-timeout closes the connection here — no sentinel
    ]))

    const chunks = await collect(provider.chatStream('some-model', [{ role: 'user', content: 'hi' }]))
    expect(chunks.find(c => c.done)?.finishReason).toBe('disconnect')
  })

  it("keeps the server's finish_reason when the stream ends without [DONE]", async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([
      '{"choices":[{"delta":{"content":"partial"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      // server omits the [DONE] sentinel (some llama.cpp builds do)
    ]))

    const chunks = await collect(provider.chatStream('some-model', [{ role: 'user', content: 'hi' }]))
    expect(chunks.find(c => c.done)?.finishReason).toBe('stop')
  })
})

describe('getContextLength — server catalogue beats name heuristic', () => {
  it('uses context_length from /models for cloud models after listModels ran', async () => {
    const provider = new OpenAIProvider(makeConfig())
    // Name heuristic alone would say 32768 for a qwen3.x name.
    expect(await provider.getContextLength('Qwen/Qwen3.6-35B-A3B')).toBe(32768)

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{
        id: 'Qwen/Qwen3.6-35B-A3B', object: 'model',
        context_length: 262144, think: 'toggle',
      }],
    }), { status: 200 }))
    const models = await provider.listModels()
    expect(models[0].contextLength).toBe(262144)

    // The catalogue value must now win — otherwise applyMaxTokens computes
    // headroom against 32k and starves long chats down to the 256 floor.
    expect(await provider.getContextLength('Qwen/Qwen3.6-35B-A3B')).toBe(262144)
  })
})

describe('THINKING_COMPATIBLE — post-2025 reasoning families (Ollama)', () => {
  it.each([
    'gpt-oss:20b',
    'gpt-oss:120b',
    'magistral:24b',
    'deepseek-v3.1:671b',
    'deepseek-v3.2',
    'exaone-deep:7.8b',
    'phi4-reasoning',
    'phi4-reasoning:plus',
    'phi4-mini-reasoning',
    'glm4.6',
    'glm4.7:cloud',
    'kimi-k2-thinking',
    'minimax-m2',
    'huihui_ai/gpt-oss-abliterated:20b',
  ])('enables the Think toggle for %s', (name) => {
    expect(isThinkingCompatible(name)).toBe(true)
  })

  it.each([
    'deepseek-v3',      // pre-3.1 — no think param
    'glm4:9b',          // plain GLM4 is not a hybrid reasoner
    'llama3.1:8b',
    'mistral:7b',
  ])('keeps the Think toggle off for %s', (name) => {
    expect(isThinkingCompatible(name)).toBe(false)
  })
})
