import { describe, it, expect } from 'vitest'
import { INTENTS, INTENT_MAP } from '../intents'

// David 2026-07-10: the advanced ops have no local models — they exist only on
// the cloud backend. Only plain generation and removebg (local RMBG node,
// rhodium92/e9aab21) keep a local lane.
describe('intent cloud gating', () => {
  it('edit, animate, upscale and eraser are cloud-only', () => {
    for (const id of ['edit', 'animate', 'upscale', 'eraser'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
    }
  })

  it('image, video and removebg stay available locally', () => {
    for (const id of ['image', 'video', 'removebg'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBeUndefined()
    }
  })

  it('the local IntentBar filter keeps exactly the local lane', () => {
    const local = INTENTS.filter((m) => !m.cloudOnly).map((m) => m.id)
    expect(local).toEqual(['image', 'removebg', 'video'])
  })
})
