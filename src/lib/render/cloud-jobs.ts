// Desktop port: shared render types + intent mapping. The HTTP client (upload/
// submit/poll/cancel against lu-labs.ai) lives in api/cloud/jobs.ts.

import type { CreateIntent } from '../../stores/createStore'

export type RenderKind = 'image' | 'video'
// 'upscale'/'eraser' are WaveSpeed utility endpoints (super-resolution / masked
// object removal). Wired in the backend; the desktop Create UI surfaces them in
// a follow-up port.
export type RenderOp = 'generate' | 'edit' | 'removebg' | 'animate' | 'upscale' | 'eraser'

export interface CloudQuota {
  tier: string
  period: string
  limits: { tokens: number; credits: number }
  costs: { image: number; video: number }
  used: { tokens_used: number; credits_used: number }
  remaining: { tokens: number; credits: number }
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
