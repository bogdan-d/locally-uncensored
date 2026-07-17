import { describe, it, expect } from 'vitest'
import { INTENTS, INTENT_MAP } from '../intents'

// David 2026-07-10 made the advanced ops cloud-only; David 2026-07-12 brought
// Edit BACK to local as the 4th local tab (checkpoint mask inpaint —
// VAEEncodeForInpaint / InpaintModelConditioning); David 2026-07-17 brought
// Animate (local I2V) back as the 5th — the lu-labs port had regressed it to
// cloud-only. Only the true hosted-endpoint ops (upscale, eraser) stay cloud.
describe('intent cloud gating', () => {
  it('upscale and eraser are cloud-only', () => {
    for (const id of ['upscale', 'eraser'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
    }
  })

  it('image, edit, video, removebg and animate stay available locally', () => {
    for (const id of ['image', 'edit', 'video', 'removebg', 'animate'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBeUndefined()
    }
  })

  it('the local IntentBar filter keeps exactly the 5 local tabs', () => {
    const local = INTENTS.filter((m) => !m.cloudOnly).map((m) => m.id)
    expect(local).toEqual(['image', 'edit', 'removebg', 'video', 'animate'])
  })

  it('local edit gates on the inpaint capability + image models', () => {
    expect(INTENT_MAP.edit.capability).toBe('inpaint-nodes')
    expect(INTENT_MAP.edit.requiresModels).toBe('image')
    expect(INTENT_MAP.edit.allowsMask).toBe(true)
    // The fresh-PC Download & install card also covers plain generation.
    expect(INTENT_MAP.image.requiresModels).toBe('image')
    expect(INTENT_MAP.video.requiresModels).toBe('video')
  })

  it('local animate needs a source image and gates on video models', () => {
    expect(INTENT_MAP.animate.needsSource).toBe(true)
    expect(INTENT_MAP.animate.isVideo).toBe(true)
    expect(INTENT_MAP.animate.requiresModels).toBe('video')
  })
})
