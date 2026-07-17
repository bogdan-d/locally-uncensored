// Static SEED of the hosted render catalog — the offline/never-fetched
// fallback only. The live truth is GET /api/jobs/catalog (fetched into
// cloudCatalogStore on every account probe), so a shipped build picks up
// fleet/pricing changes without an app update. Keep the ids in sync with
// uselu apps/web/lib/render/cloud-models.ts when touching this file.

import type { RenderKind, RenderOp } from './cloud-jobs'

export interface CloudModel {
  id: string
  label: string
  kind: RenderKind
  /** Supports the masked img2img 'edit' op (flux-dev only today). */
  edit?: boolean
  /** Video: renders text-to-video (the "Video" intent). Absent = yes; set false
   *  on an i2v-only model to keep it out of the Video picker. */
  t2v?: boolean
  /** Video: renders image-to-video (the "Animate Image" intent). Absent = yes;
   *  set false on a t2v-only model to keep it out of the Animate picker. */
  i2v?: boolean
  /** 2.5.8 op-specialized models (trainers, lipsync, voice, music, extend,
   *  motion, LoRA-gen): exactly the ops this model serves. Absent on classic
   *  models — every classic picker filters on `!m.ops`. */
  ops?: RenderOp[]
  /** Character-Studio generation endpoint: accepts `params.loras`. */
  lora?: boolean
  /** Lipsync base input: still portrait ('image') or existing clip ('video'). */
  lipsync_source?: 'image' | 'video'
  /** Whether the hosted endpoint honours guidance_scale (CFG). */
  cfg?: boolean
  /** Whether the hosted endpoint honours negative_prompt. */
  negative_prompt?: boolean
  /** Video: clip lengths the model books (5s short / 8s long). */
  clip?: { short: number; long?: number }
  /** Per-run credit cost (base = image or 5s clip, long = 8s clip; music
   *  models additionally quote per_s for the duration slider). */
  credits?: { base: number; long?: number; per_s?: number }
}

const CLIP = { short: 5, long: 8 }

export const CLOUD_MODEL_SEED: CloudModel[] = [
  { id: 'flux-schnell', label: 'Flux Schnell (fast)', kind: 'image', cfg: true },
  { id: 'flux-dev', label: 'Flux Dev (quality)', kind: 'image', edit: true, cfg: true },
  { id: 'flux-2-dev', label: 'Flux 2 Dev', kind: 'image' },
  { id: 'qwen-image', label: 'Qwen Image', kind: 'image' },
  { id: 'hidream', label: 'HiDream', kind: 'image' },
  { id: 'hunyuan-image', label: 'HunyuanImage 2.1', kind: 'image' },
  { id: 'z-image-turbo', label: 'Z-Image Turbo (fast)', kind: 'image' },
  { id: 'chroma', label: 'Chroma', kind: 'image' },
  { id: 'prefect-pony', label: 'Prefect Pony XL', kind: 'image' },
  { id: 'neta-lumina', label: 'Neta Lumina (anime)', kind: 'image' },
  // Every hosted clip model does both t2v + i2v, so both flags are true. They're
  // the enforced contract (Video/Animate pickers + submit filter on them), not a
  // note — a future t2v-only or i2v-only model MUST set the flag it lacks to
  // false. Server truth is /api/jobs/catalog; keep in sync with uselu.
  { id: 'wan-2.2-720p', label: 'Wan 2.2 720p', kind: 'video', t2v: true, i2v: true, negative_prompt: true, clip: CLIP },
  { id: 'wan-2.2-fast', label: 'Wan 2.2 Fast', kind: 'video', t2v: true, i2v: true, negative_prompt: true, clip: CLIP },
  { id: 'ltx-2', label: 'LTX-2 (with audio)', kind: 'video', t2v: true, i2v: true, clip: CLIP },
  { id: 'hunyuan-video', label: 'HunyuanVideo 1.5', kind: 'video', t2v: true, i2v: true, negative_prompt: true, clip: CLIP },
  { id: 'ltx-2.3', label: 'LTX 2.3', kind: 'video', t2v: true, i2v: true, clip: CLIP },

  // ── 2.5.8 op-specialized fleet (Character-Studio / lipsync / voice / music /
  // extend / motion). `ops` keeps them out of every classic picker; the live
  // catalog (?v=2) is the pricing truth. Face-swap is banned from this list. ──
  { id: 'flux-lora-trainer', label: 'Flux Character Training', kind: 'image', ops: ['lora-train'] },
  { id: 'z-image-lora-trainer', label: 'Z-Image Character Training', kind: 'image', ops: ['lora-train'] },
  { id: 'qwen-image-lora-trainer', label: 'Qwen Character Training', kind: 'image', ops: ['lora-train'] },
  { id: 'ltx-2-video-lora-trainer', label: 'LTX-2 Video Character Training', kind: 'video', ops: ['lora-train'], t2v: false, i2v: false },
  { id: 'flux-schnell-lora', label: 'Flux Schnell + Character', kind: 'image', ops: ['generate'], lora: true, cfg: true },
  { id: 'flux-dev-lora-ultra-fast', label: 'Flux Dev Fast + Character', kind: 'image', ops: ['generate'], lora: true, cfg: true },
  { id: 'z-image-turbo-lora', label: 'Z-Image Turbo + Character', kind: 'image', ops: ['generate'], lora: true },
  { id: 'z-image-base-lora', label: 'Z-Image + Character', kind: 'image', ops: ['generate'], lora: true },
  { id: 'infinitetalk-fast', label: 'InfiniteTalk (photo avatar)', kind: 'video', ops: ['lipsync'], lipsync_source: 'image', t2v: false, i2v: false },
  { id: 'p-video-avatar', label: 'P-Video Avatar (photo, fast)', kind: 'video', ops: ['lipsync'], lipsync_source: 'image', t2v: false, i2v: false },
  { id: 'latentsync', label: 'LatentSync (re-sync a clip)', kind: 'video', ops: ['lipsync'], lipsync_source: 'video', t2v: false, i2v: false },
  { id: 'lipsync-2', label: 'Lipsync-2 (re-sync a clip)', kind: 'video', ops: ['lipsync'], lipsync_source: 'video', t2v: false, i2v: false },
  { id: 'qwen3-tts', label: 'Qwen3 TTS (voices)', kind: 'audio', ops: ['tts'] },
  { id: 'qwen3-tts-clone', label: 'Qwen3 TTS Voice Clone', kind: 'audio', ops: ['tts'] },
  { id: 'qwen3-tts-design', label: 'Qwen3 TTS Voice Design', kind: 'audio', ops: ['tts'] },
  { id: 'ace-step', label: 'ACE-Step (fast)', kind: 'audio', ops: ['music'], credits: { base: 1200, per_s: 20 } },
  { id: 'ace-step-1.5', label: 'ACE-Step 1.5', kind: 'audio', ops: ['music'], credits: { base: 1800, per_s: 30 } },
  { id: 'sonilo-music', label: 'Sonilo Music', kind: 'audio', ops: ['music'], credits: { base: 15000, per_s: 250 } },
  { id: 'wan-2.2-spicy-extend', label: 'Wan 2.2 Spicy Extend', kind: 'video', ops: ['extend'], t2v: false, i2v: false },
  { id: 'ltx-2-extend', label: 'LTX-2 Extend', kind: 'video', ops: ['extend'], t2v: false, i2v: false },
  { id: 'pixverse-extend', label: 'Pixverse Extend (fast)', kind: 'video', ops: ['extend'], t2v: false, i2v: false },
  { id: 'wan-2.2-animate', label: 'Wan 2.2 Animate', kind: 'video', ops: ['motion'], t2v: false, i2v: false },
  { id: 'steady-dancer', label: 'SteadyDancer', kind: 'video', ops: ['motion'], t2v: false, i2v: false },
  { id: 'p-video-animate', label: 'P-Video Animate (fast)', kind: 'video', ops: ['motion'], t2v: false, i2v: false },
  { id: 'dreamactor-v2', label: 'DreamActor v2', kind: 'video', ops: ['motion'], t2v: false, i2v: false },
]
