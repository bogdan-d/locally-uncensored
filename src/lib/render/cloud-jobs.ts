// Desktop port: types + intent mapping only. The hosted render queue (fetch
// wrappers, upload/submit/poll/cancel) is a lu-labs.ai web feature and stays
// out of the desktop build — CreateContext stubs the cloud axis to null.

import type { CreateIntent } from '../../stores/createStore'

export type RenderKind = 'image' | 'video'
export type RenderOp = 'generate' | 'edit' | 'removebg' | 'animate'

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
