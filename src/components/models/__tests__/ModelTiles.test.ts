import { describe, it, expect } from 'vitest'
import { computeFit, groupModels, pickDefaultVariant } from '../ModelTiles'
import type { DiscoverModel, DownloadProgress } from '../../../api/discover'

// The fit hint is a pure function of (model size, DETECTED vram) — these
// cases pin down what end users on different GPUs actually see, without
// needing the hardware on a test box. Thresholds: fits ≤ 0.85×VRAM (leave
// headroom for KV-cache/context), tight ≤ 1.15×VRAM, else big.
describe('computeFit — per-user hardware hint', () => {
  it('returns unknown (→ hint hidden) when hardware or size is missing', () => {
    expect(computeFit(undefined, 12)).toBe('unknown')
    expect(computeFit(5, null)).toBe('unknown')
    expect(computeFit(0, 12)).toBe('unknown')
  })

  it('8 GB GPU: small models green, 12B-class tight, 20B-class red', () => {
    expect(computeFit(5, 8)).toBe('fits')      // 8B Q4
    expect(computeFit(6.9, 8)).toBe('tight')   // 12B Q4 — loads, little headroom
    expect(computeFit(8, 8)).toBe('tight')     // exactly at VRAM
    expect(computeFit(13, 8)).toBe('big')
  })

  it('12 GB GPU (the dev box): 10 GB quant green, 13 GB tight, 16 GB red', () => {
    expect(computeFit(10, 12)).toBe('fits')    // GLM 4.7 Flash IQ2_M
    expect(computeFit(13, 12)).toBe('tight')   // Qwen 3.6 27B Q3
    expect(computeFit(16, 12)).toBe('big')     // 27B Q4
  })

  it('24 GB GPU: 20 GB MoEs green, 25 GB tight', () => {
    expect(computeFit(20, 24)).toBe('fits')
    expect(computeFit(25, 24)).toBe('tight')
    expect(computeFit(42, 24)).toBe('big')
  })

  it('48–50 GB GPU: 23 GB Ornith green; the 42 GB 70B flips tight→green at 50', () => {
    expect(computeFit(23, 48)).toBe('fits')    // Ornith 1.0 35B
    expect(computeFit(42, 48)).toBe('tight')   // 70B Q4 — real headroom is thin
    expect(computeFit(42, 50)).toBe('fits')    // 42 ≤ 50×0.85
    expect(computeFit(45, 50)).toBe('tight')   // Mistral Medium 3.5
    expect(computeFit(144, 50)).toBe('big')    // DeepSeek V4 Flash multi-part
  })

  it('never hides or blocks — big is a hint, not a gate (see FIT_META copy)', () => {
    // computeFit only classifies; there is no code path from 'big' to a
    // disabled Get button — asserted here as a contract statement.
    expect(computeFit(371, 12)).toBe('big')
  })
})

const M = (name: string, sizeGB: number, extra: Partial<DiscoverModel> = {}): DiscoverModel => ({
  name, description: name, pulls: '', tags: [], updated: '', sizeGB, ...extra,
})
const noDl = (_m: DiscoverModel): DownloadProgress | null => null
const notInstalled = (_m: DiscoverModel) => false

describe('pickDefaultVariant — the size picker recommendation', () => {
  const variants = [
    M('Q8', 27, { group: 'G' }),
    M('Q4', 16, { group: 'G' }),
    M('IQ2', 9, { group: 'G' }),
  ]

  it('no hardware detected → smallest variant (safe default)', () => {
    expect(pickDefaultVariant(variants, null, notInstalled, noDl).name).toBe('IQ2')
  })

  it('12 GB GPU → largest variant that still fits (9 GB, not 16)', () => {
    expect(pickDefaultVariant(variants, 12, notInstalled, noDl).name).toBe('IQ2')
  })

  it('24 GB GPU → the 16 GB quant; 50 GB GPU → the 27 GB quant', () => {
    expect(pickDefaultVariant(variants, 24, notInstalled, noDl).name).toBe('Q4')
    expect(pickDefaultVariant(variants, 50, notInstalled, noDl).name).toBe('Q8')
  })

  it('an installed variant always wins over the fit recommendation', () => {
    const installed = (m: DiscoverModel) => m.name === 'Q8'
    expect(pickDefaultVariant(variants, 12, installed, noDl).name).toBe('Q8')
  })
})

describe('groupModels — quant collapsing', () => {
  it('groups by `group` key, preserves catalog order, singletons stay single', () => {
    const models = [
      M('A Q4', 16, { group: 'A' }),
      M('B', 5),
      M('A Q8', 27, { group: 'A' }),
    ]
    const groups = groupModels(models)
    expect(groups.length).toBe(2)
    expect(groups[0].map(m => m.name)).toEqual(['A Q4', 'A Q8'])
    expect(groups[1].map(m => m.name)).toEqual(['B'])
  })
})
