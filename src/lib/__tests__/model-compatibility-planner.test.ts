/**
 * isPlainTextPlanner Tests (Bug #80 + Mobile parity)
 *
 * Gemma 3/4 with `think: false` drops into plain-text structured planning
 * ("Plan:", "Constraint Checklist:", "Confidence Score:") instead of
 * emitting strippable tags. `isPlainTextPlanner` identifies those models
 * so callers can pass `thinking: undefined` (Ollama default = tagged
 * thinking) as a bypass.
 *
 * The mobile (remote.rs) JS code uses an identical algorithm.
 *
 * Run: npx vitest run src/lib/__tests__/model-compatibility-planner.test.ts
 */
import { describe, it, expect } from 'vitest'
import { isPlainTextPlanner } from '../model-compatibility'

describe('isPlainTextPlanner', () => {
  describe('positive matches — Gemma 3/4 variants', () => {
    it('matches gemma3', () => {
      expect(isPlainTextPlanner('gemma3')).toBe(true)
    })
    it('matches gemma3:27b', () => {
      expect(isPlainTextPlanner('gemma3:27b')).toBe(true)
    })
    it('matches gemma3:12b-instruct', () => {
      expect(isPlainTextPlanner('gemma3:12b-instruct')).toBe(true)
    })
    it('matches gemma4', () => {
      expect(isPlainTextPlanner('gemma4')).toBe(true)
    })
    it('matches gemma4:31b', () => {
      expect(isPlainTextPlanner('gemma4:31b')).toBe(true)
    })
    it('matches gemma4-abliterated variants', () => {
      expect(isPlainTextPlanner('gemma4-abliterated')).toBe(true)
      expect(isPlainTextPlanner('gemma4-abliterated:8b')).toBe(true)
    })
    it('matches gemma4-uncensored variants', () => {
      expect(isPlainTextPlanner('gemma4-uncensored')).toBe(true)
    })
    it('is case-insensitive', () => {
      expect(isPlainTextPlanner('Gemma4')).toBe(true)
      expect(isPlainTextPlanner('GEMMA3:27B')).toBe(true)
    })
    it('strips single-segment org prefix', () => {
      // The algorithm strips exactly ONE leading slash-terminated segment
      // (`org/model` → `model`). Multi-slash HF paths (`hf.co/org/model`)
      // leave an intermediate "org" in front so they do NOT match — this
      // is intentional since we control the identifier format at the
      // provider layer.
      expect(isPlainTextPlanner('library/gemma4:31b')).toBe(true)
      expect(isPlainTextPlanner('ollama/gemma3:27b')).toBe(true)
    })
  })

  describe('negative matches — other models do NOT trigger bypass', () => {
    it('gemma2 → false (not affected)', () => {
      expect(isPlainTextPlanner('gemma2')).toBe(false)
      expect(isPlainTextPlanner('gemma2:9b')).toBe(false)
    })
    it('qwen3 → false (uses <think> tags, stripper works fine)', () => {
      expect(isPlainTextPlanner('qwen3')).toBe(false)
      expect(isPlainTextPlanner('qwen3:32b')).toBe(false)
    })
    it('deepseek-r1 → false', () => {
      expect(isPlainTextPlanner('deepseek-r1')).toBe(false)
    })
    it('qwq → false', () => {
      expect(isPlainTextPlanner('qwq')).toBe(false)
    })
    it('llama3 → false (no thinking at all)', () => {
      expect(isPlainTextPlanner('llama3')).toBe(false)
    })
    it('hermes3 → false', () => {
      expect(isPlainTextPlanner('hermes3')).toBe(false)
    })
    it('empty / null → false', () => {
      expect(isPlainTextPlanner(null)).toBe(false)
      expect(isPlainTextPlanner('')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('gemma (no version suffix) → false — too ambiguous', () => {
      expect(isPlainTextPlanner('gemma')).toBe(false)
      expect(isPlainTextPlanner('gemma:latest')).toBe(false)
    })
    it('a substring match inside a different name → false', () => {
      // e.g. a hypothetical model named "stuff-gemma3-X". Since our logic
      // strips the org prefix then checks startsWith, this only triggers
      // if the base name (after / and before :) starts with gemma3/4.
      expect(isPlainTextPlanner('stuff-gemma3-mix')).toBe(false)
    })
    it('gemma3 inside a single-segment org namespace triggers correctly', () => {
      expect(isPlainTextPlanner('mradermacher/gemma3-27b-it-GGUF')).toBe(true)
    })
    it('multi-segment HF path like "hf.co/bart/gemma4-X" → false (by design)', () => {
      // Known limitation — see the single-segment test above for the
      // rationale. Documenting so regressions don't accidentally "fix"
      // this case and shift model-matching semantics.
      expect(
        isPlainTextPlanner('hf.co/bartowski/gemma4-27B-it-GGUF:Q4_K_M')
      ).toBe(false)
    })
  })
})
