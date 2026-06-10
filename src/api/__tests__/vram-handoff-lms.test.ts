/**
 * LM Studio text-model juggling (v2.5.3). Live E2E 2026-06-10 found the gap:
 * the orchestrator only evicted OLLAMA text models, so a loaded LM Studio
 * model (qwen2.5-vl-7b, ~5 GB) stayed resident through an SDXL generation —
 * 11.9/12 GB VRAM, thrashing. These tests pin the detection + estimate
 * helpers; the unload/reload wiring mirrors the proven Ollama path.
 *
 * Run: npx vitest run src/api/__tests__/vram-handoff-lms.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn() }
})

import { detectLmsTextModel, estimateLmsTextVramBytes } from '../vram-handoff'
import { backendCall } from '../backend'

beforeEach(() => {
  vi.mocked(backendCall).mockReset()
})

describe('detectLmsTextModel', () => {
  it('detects a loaded local LM Studio model and strips the openai:: prefix', async () => {
    vi.mocked(backendCall).mockResolvedValue({ loaded: 8192, max: 32768, state: 'loaded' } as never)
    const r = await detectLmsTextModel({ name: 'openai::qwen/qwen2.5-vl-7b', providerId: 'openai' })
    expect(r).toEqual({ id: 'qwen/qwen2.5-vl-7b', contextLength: 8192 })
    expect(backendCall).toHaveBeenCalledWith('lmstudio_model_context', { model: 'qwen/qwen2.5-vl-7b' })
  })

  it('bare ids (no prefix) work too', async () => {
    vi.mocked(backendCall).mockResolvedValue({ loaded: null, max: null, state: 'loaded' } as never)
    const r = await detectLmsTextModel({ name: 'qwen/qwen2.5-vl-7b', providerId: 'openai' })
    expect(r).toEqual({ id: 'qwen/qwen2.5-vl-7b', contextLength: null })
  })

  it('not-loaded state → null (model holds no VRAM)', async () => {
    vi.mocked(backendCall).mockResolvedValue({ loaded: null, max: 32768, state: 'not-loaded' } as never)
    expect(await detectLmsTextModel({ name: 'qwen/qwen2.5-vl-7b', providerId: 'openai' })).toBeNull()
  })

  it('LM Studio absent / REST error → null (cloud OpenAI stays untouched)', async () => {
    vi.mocked(backendCall).mockRejectedValue(new Error('lms CLI not found'))
    expect(await detectLmsTextModel({ name: 'gpt-4o', providerId: 'openai' })).toBeNull()
  })

  it('non-openai providers never probe', async () => {
    expect(await detectLmsTextModel({ name: 'gemma4:e4b', providerId: 'ollama' })).toBeNull()
    expect(await detectLmsTextModel(null)).toBeNull()
    expect(backendCall).not.toHaveBeenCalled()
  })
})

describe('estimateLmsTextVramBytes', () => {
  it('parses parameter counts from common ids', () => {
    expect(estimateLmsTextVramBytes('qwen/qwen2.5-vl-7b')).toBe(Math.round(7 * 0.75 * 1e9))
    expect(estimateLmsTextVramBytes('qwen2.5-0.5b-instruct@q4_k_m')).toBe(Math.round(0.5 * 0.75 * 1e9))
    expect(estimateLmsTextVramBytes('mlabonne_gemma-3-4b-it-abliterated')).toBe(Math.round(4 * 0.75 * 1e9))
  })

  it('no parseable size → undefined (decideUnload keeps the safe default)', () => {
    expect(estimateLmsTextVramBytes('mistral-large')).toBeUndefined()
    expect(estimateLmsTextVramBytes('')).toBeUndefined()
  })

  it('does not mistake quant suffixes for parameter counts', () => {
    // "@q8_0" / "q4_k_m" must not parse as 8b/4b. The regex requires "<n>b".
    expect(estimateLmsTextVramBytes('llama-3.2-3b@q8_0')).toBe(Math.round(3 * 0.75 * 1e9))
  })
})
