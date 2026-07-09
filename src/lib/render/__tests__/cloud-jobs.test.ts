import { describe, it, expect } from 'vitest'
import { intentToJob } from '../cloud-jobs'
import type { CreateIntent } from '../../../stores/createStore'

describe('intentToJob', () => {
  it('maps every Create intent onto its queue kind + op', () => {
    const cases: Record<CreateIntent, { kind: string; op: string }> = {
      image: { kind: 'image', op: 'generate' },
      edit: { kind: 'image', op: 'edit' },
      removebg: { kind: 'image', op: 'removebg' },
      upscale: { kind: 'image', op: 'upscale' },
      eraser: { kind: 'image', op: 'eraser' },
      video: { kind: 'video', op: 'generate' },
      animate: { kind: 'video', op: 'animate' },
    }
    for (const [intent, expected] of Object.entries(cases)) {
      expect(intentToJob(intent as CreateIntent)).toEqual(expected)
    }
  })
})
