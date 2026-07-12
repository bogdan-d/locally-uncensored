import { describe, it, expect, beforeEach, vi } from 'vitest'

// The built-in engine (2.5.7) holds its GGUF in VRAM with -ngl 999. Switching
// away from a built-in model to any OTHER local backend must stop the sidecar,
// or two models sit in VRAM at once. These tests lock that mutual-exclusion.

const backendCall = vi.fn(async () => ({}))
const unloadModel = vi.fn(async () => undefined)
const unloadLmStudioModel = vi.fn(async () => undefined)

vi.mock('../../api/backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...a),
  isTauri: () => true,
}))
vi.mock('../../api/ollama', () => ({
  unloadModel: (...a: unknown[]) => unloadModel(...a),
}))
vi.mock('../../api/lmstudio', () => ({
  unloadLmStudioModel: (...a: unknown[]) => unloadLmStudioModel(...a),
}))
vi.mock('../../lib/hf-to-provider', () => ({
  isLmStudioProvider: (n?: string) => (n || '').includes('LM Studio'),
}))

import { useModelStore } from '../modelStore'
import type { AIModel } from '../../types/models'

const builtin = (name: string): AIModel =>
  ({ name: `openai::${name}`, model: name, size: 1, type: 'text', provider: 'openai', providerName: 'Built-in Engine' } as unknown as AIModel)
const ollama = (name: string): AIModel =>
  ({ name, model: name, size: 1, type: 'text' } as unknown as AIModel)
const lms = (name: string): AIModel =>
  ({ name: `openai::${name}`, model: name, size: 1, type: 'text', provider: 'openai', providerName: 'LM Studio' } as unknown as AIModel)

describe('modelStore.setActiveModel — built-in engine VRAM exclusion (2.5.7)', () => {
  beforeEach(() => {
    backendCall.mockClear(); unloadModel.mockClear(); unloadLmStudioModel.mockClear()
    useModelStore.setState({
      models: [builtin('qwenA'), builtin('qwenB'), ollama('llama3'), lms('mistral')],
      activeModel: null,
    })
  })

  it('stops the built-in engine when switching built-in → Ollama', () => {
    useModelStore.getState().setActiveModel('openai::qwenA') // prev null → no-op
    useModelStore.getState().setActiveModel('llama3')
    expect(backendCall).toHaveBeenCalledWith('stop_bundled_engine')
  })

  it('stops the built-in engine when switching built-in → LM Studio', () => {
    useModelStore.getState().setActiveModel('openai::qwenA')
    useModelStore.getState().setActiveModel('openai::mistral')
    expect(backendCall).toHaveBeenCalledWith('stop_bundled_engine')
  })

  it('does NOT stop the engine on built-in → built-in (that is an in-place swap)', () => {
    useModelStore.getState().setActiveModel('openai::qwenA')
    useModelStore.getState().setActiveModel('openai::qwenB')
    expect(backendCall).not.toHaveBeenCalledWith('stop_bundled_engine')
  })

  it('still unloads the previous Ollama model on Ollama → built-in (no regression)', () => {
    useModelStore.getState().setActiveModel('llama3')
    useModelStore.getState().setActiveModel('openai::qwenA')
    expect(unloadModel).toHaveBeenCalledWith('llama3')
    expect(backendCall).not.toHaveBeenCalledWith('stop_bundled_engine')
  })
})
