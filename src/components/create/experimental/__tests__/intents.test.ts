import { describe, it, expect } from 'vitest'
import { INTENTS, INTENT_MAP } from '../intents'
import { LOCAL_LANE_OPS } from '../../../../stores/createStore'

// David 2026-07-10 made the advanced ops cloud-only; David 2026-07-12 brought
// Edit BACK to local as the 4th local tab (checkpoint mask inpaint —
// VAEEncodeForInpaint / InpaintModelConditioning); David 2026-07-17 brought
// Animate (local I2V) back as the 5th — the lu-labs port had regressed it to
// cloud-only. 2.5.8 gives ALL five specialized categories REAL local lanes
// (hasLocalLane): music / lipsync / extend / motion on core ComfyUI node
// families, character training on the bundled musubi trainer. Only upscale
// and eraser remain hosted-only.
describe('intent cloud gating', () => {
  it('upscale and eraser stay hosted-only (no local lane)', () => {
    for (const id of ['upscale', 'eraser'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
      expect(INTENT_MAP[id].hasLocalLane, id).toBeUndefined()
    }
  })

  it('image, edit, video, removebg and animate stay available locally', () => {
    for (const id of ['image', 'edit', 'video', 'removebg', 'animate'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBeUndefined()
    }
  })

  it('the 2.5.8 lanes are dual: hosted clip AND a local lane', () => {
    for (const id of ['music', 'lipsync', 'extend', 'motion', 'character'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
      expect(INTENT_MAP[id].hasLocalLane, id).toBe(true)
    }
  })

  it('intent metadata mirrors the store LOCAL_LANE_OPS set exactly', () => {
    const fromMeta = INTENTS.filter((m) => m.hasLocalLane).map((m) => m.id).sort()
    expect(fromMeta).toEqual([...LOCAL_LANE_OPS].sort())
  })

  it('the local IntentBar filter keeps the 5 classic tabs plus the 5 lanes selectable', () => {
    const selectable = INTENTS.filter((m) => !m.cloudOnly || m.hasLocalLane).map((m) => m.id)
    expect(selectable).toEqual(['image', 'edit', 'removebg', 'video', 'animate', 'character', 'lipsync', 'music', 'extend', 'motion'])
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

  it('the lanes gate on their own model kinds + the pose capability', () => {
    expect(INTENT_MAP.music.requiresModels).toBe('audio')
    expect(INTENT_MAP.lipsync.requiresModels).toBe('lipsync')
    // Extend rides the regular i2v-capable video list (last-frame continue).
    expect(INTENT_MAP.extend.requiresModels).toBe('video')
    expect(INTENT_MAP.motion.requiresModels).toBe('motion')
    expect(INTENT_MAP.motion.capability).toBe('dwpose')
    // Character gates itself inside its panel (trainer env + base files),
    // not on a ComfyUI model list.
    expect(INTENT_MAP.character.requiresModels).toBeUndefined()
  })
})
