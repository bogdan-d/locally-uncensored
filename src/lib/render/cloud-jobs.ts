// Desktop port: shared render types + intent mapping. The HTTP client (upload/
// submit/poll/cancel against lu-labs.ai) lives in api/cloud/jobs.ts.

import type { CreateIntent } from '../../stores/createStore'

export type RenderKind = 'image' | 'video'
// 'upscale'/'eraser' are WaveSpeed utility endpoints (super-resolution / masked
// object removal). Wired in the backend; the desktop Create UI surfaces them in
// a follow-up port.
export type RenderOp = 'generate' | 'edit' | 'removebg' | 'animate' | 'upscale' | 'eraser'

// One shared compute-credit wallet — text + media draw from the same budget
// (server shape: uselu /api/jobs/quota).
export interface CloudQuota {
  tier: string
  period: string
  limits: { credits: number }
  costs: { image: number; video: number }
  used: { credits_used: number }
  remaining: { credits: number }
}

/** Which queue kind + workflow op a Create intent renders as. */
export function intentToJob(intent: CreateIntent): { kind: RenderKind; op: RenderOp } {
  switch (intent) {
    case 'edit':
      return { kind: 'image', op: 'edit' }
    case 'removebg':
      return { kind: 'image', op: 'removebg' }
    case 'video':
      return { kind: 'video', op: 'generate' }
    case 'animate':
      return { kind: 'video', op: 'animate' }
    default:
      return { kind: 'image', op: 'generate' }
  }
}
