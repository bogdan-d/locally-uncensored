import { describe, it, expect } from 'vitest'
import {
  BUILTIN_BACKEND_ID,
  classifyOnboardingBackend,
  resolveOnboardingBackend,
} from '../onboarding-backend'

describe('resolveOnboardingBackend', () => {
  it('honours an explicit selection (built-in default)', () => {
    expect(resolveOnboardingBackend(BUILTIN_BACKEND_ID, false, [])).toBe('builtin')
    expect(resolveOnboardingBackend('lmstudio', true, [{ id: 'ollama' }])).toBe('lmstudio')
  })

  it('falls back to ollama when it was just installed in-app', () => {
    expect(resolveOnboardingBackend('', true, [])).toBe('ollama')
  })

  it('falls back to the first detected backend when nothing is selected', () => {
    expect(resolveOnboardingBackend('', false, [{ id: 'jan' }, { id: 'vllm' }])).toBe('jan')
  })

  it('defaults to the built-in engine when there is nothing else', () => {
    expect(resolveOnboardingBackend('', false, [])).toBe(BUILTIN_BACKEND_ID)
  })
})

describe('classifyOnboardingBackend', () => {
  it('routes the built-in engine to its own path', () => {
    expect(classifyOnboardingBackend('builtin')).toBe('builtin')
  })

  it('routes ollama to the pull path', () => {
    expect(classifyOnboardingBackend('ollama')).toBe('ollama')
  })

  it('routes every other backend to the OpenAI-compat direct-write path', () => {
    for (const id of ['lmstudio', 'vllm', 'jan', 'koboldcpp', 'localai']) {
      expect(classifyOnboardingBackend(id)).toBe('openai-compat')
    }
  })
})
