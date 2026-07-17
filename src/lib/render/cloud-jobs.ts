// Desktop port: shared render types + intent mapping. The HTTP client (upload/
// submit/poll/cancel against lu-labs.ai) lives in api/cloud/jobs.ts.

import type { CreateIntent } from '../../stores/createStore'

export type RenderKind = 'image' | 'video' | 'audio'
// 'upscale'/'eraser' are WaveSpeed utility endpoints (super-resolution /
// masked object removal) — cloud-only intents in the Create UI since 2.5.7.
// 2.5.8 adds the specialized ops behind the new Create categories: 'lipsync'
// (talking character), 'extend' (continue a clip), 'motion' (motion transfer,
// NOT face-swap — banned), 'music', 'tts' and 'lora-train' (Character-Studio).
export type RenderOp =
  | 'generate' | 'edit' | 'removebg' | 'animate' | 'upscale' | 'eraser'
  | 'lipsync' | 'extend' | 'motion' | 'music' | 'tts' | 'lora-train'

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

/** Which queue kind + workflow op a Create intent renders as.
 *  'character' maps per characterTab (train vs use) — see useCloudCreate; the
 *  default here is the training op, the use-surface submits a plain image
 *  generate with a `loras` reference. */
export function intentToJob(intent: CreateIntent): { kind: RenderKind; op: RenderOp } {
  switch (intent) {
    case 'edit':
      return { kind: 'image', op: 'edit' }
    case 'removebg':
      return { kind: 'image', op: 'removebg' }
    case 'upscale':
      return { kind: 'image', op: 'upscale' }
    case 'eraser':
      return { kind: 'image', op: 'eraser' }
    case 'video':
      return { kind: 'video', op: 'generate' }
    case 'animate':
      return { kind: 'video', op: 'animate' }
    case 'character':
      return { kind: 'image', op: 'lora-train' }
    case 'lipsync':
      return { kind: 'video', op: 'lipsync' }
    case 'music':
      return { kind: 'audio', op: 'music' }
    case 'extend':
      return { kind: 'video', op: 'extend' }
    case 'motion':
      return { kind: 'video', op: 'motion' }
    default:
      return { kind: 'image', op: 'generate' }
  }
}
