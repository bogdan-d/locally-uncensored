/**
 * Context-fill semantics for the TokenCounter (David, 2026-07-12): a looping
 * cloud reasoner burned its whole 16,384-token completion budget as hidden
 * thinking; the old high-water over usage.totalTokens pinned the counter at
 * "16.5k" for the rest of the conversation while the next real prompt cost
 * 65 tokens. Reasoning is never resent, so it is never context.
 *
 * Run: npx vitest run src/lib/__tests__/token-usage.test.ts
 */
import { describe, it, expect } from 'vitest'
import { computeContextFill, type FillMessage } from '../token-usage'
import { estimateTokens } from '../context-compaction'

const user = (content: string): FillMessage => ({ role: 'user', content })
const assistant = (content: string, extra: Partial<FillMessage> = {}): FillMessage =>
  ({ role: 'assistant', content, ...extra })

describe('computeContextFill', () => {
  it('estimates from visible content only when no usage exists', () => {
    const msgs = [user('hello there'), assistant('hi!')]
    const expected = estimateTokens('hello there') + 4 + estimateTokens('hi!') + 4
    expect(computeContextFill(msgs)).toEqual({ used: expected, real: false })
  })

  it('never counts thinking — with or without a usage anchor', () => {
    const noAnchor = [user('q'), assistant('', { thinking: 'x'.repeat(40000) })]
    expect(computeContextFill(noAnchor).used).toBeLessThan(50)

    const anchored = [
      user('q'),
      assistant('', {
        thinking: 'x'.repeat(40921),
        usage: { promptTokens: 85, completionTokens: 16384, totalTokens: 16469 },
      }),
    ]
    // The crashout turn: 85 real prompt tokens + an empty visible reply.
    // The old high-water showed 16,469 here.
    const fill = computeContextFill(anchored)
    expect(fill.used).toBeLessThan(150)
    expect(fill.used).toBeGreaterThanOrEqual(85)
    expect(fill.real).toBe(true)
  })

  it('anchors on the newest usage and adds visible messages after it', () => {
    const msgs = [
      user('first'),
      assistant('a1', { usage: { promptTokens: 500, completionTokens: 20, totalTokens: 520 } }),
      user('second'),
      assistant('a2', { usage: { promptTokens: 900, completionTokens: 30, totalTokens: 930 } }),
      user('third — not answered yet'),
    ]
    const tail =
      estimateTokens('a2') + 4 +
      estimateTokens('third — not answered yet') + 4
    expect(computeContextFill(msgs)).toEqual({ used: 900 + tail, real: true })
  })

  it('a provisional (estimated) anchor is used but not reported as real', () => {
    const msgs = [
      user('q'),
      assistant('a', { usage: { promptTokens: 300, completionTokens: 10, totalTokens: 310, estimated: true } }),
    ]
    const fill = computeContextFill(msgs)
    expect(fill.used).toBe(300 + estimateTokens('a') + 4)
    expect(fill.real).toBe(false)
  })

  it('counts toolCallSummary as visible context', () => {
    const withTool = computeContextFill([assistant('a', { toolCallSummary: 'used web_search("x") → 3 results' })])
    const without = computeContextFill([assistant('a')])
    expect(withTool.used).toBeGreaterThan(without.used)
  })

  it('an honest dip after compaction beats a sticky wrong maximum', () => {
    // Turn 1 fed an image (expensive prompt), turn 2 compacted it away.
    const msgs = [
      user('look at this image'),
      assistant('I see a cat', { usage: { promptTokens: 3500, completionTokens: 40, totalTokens: 3540 } }),
      user('thanks'),
      assistant('yw', { usage: { promptTokens: 1200, completionTokens: 5, totalTokens: 1205 } }),
    ]
    // Anchored on the NEWEST usage (1200), not the conversation maximum.
    expect(computeContextFill(msgs).used).toBeLessThan(1400)
  })
})
