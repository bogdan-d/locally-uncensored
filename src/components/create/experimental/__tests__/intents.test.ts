import { describe, it, expect } from 'vitest'
import { INTENTS, INTENT_MAP } from '../intents'

// David 2026-07-10 made the advanced ops cloud-only; David 2026-07-12 brought
// Edit BACK to local as the 4th local tab (checkpoint mask inpaint —
// VAEEncodeForInpaint / InpaintModelConditioning). Animate, upscale and eraser
// remain hosted-endpoint-only.
describe('intent cloud gating', () => {
  it('animate, upscale and eraser are cloud-only', () => {
    for (const id of ['animate', 'upscale', 'eraser'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
    }
  })

  it('image, edit, video and removebg stay available locally', () => {
    for (const id of ['image', 'edit', 'video', 'removebg'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBeUndefined()
    }
  })

  it('the local IntentBar filter keeps exactly the 4 local tabs', () => {
    const local = INTENTS.filter((m) => !m.cloudOnly).map((m) => m.id)
    expect(local).toEqual(['image', 'edit', 'removebg', 'video'])
  })

  it('local edit gates on the inpaint capability + image models', () => {
    expect(INTENT_MAP.edit.capability).toBe('inpaint-nodes')
    expect(INTENT_MAP.edit.requiresModels).toBe('image')
    expect(INTENT_MAP.edit.allowsMask).toBe(true)
    // The fresh-PC Download & install card also covers plain generation.
    expect(INTENT_MAP.image.requiresModels).toBe('image')
    expect(INTENT_MAP.video.requiresModels).toBe('video')
  })
})
