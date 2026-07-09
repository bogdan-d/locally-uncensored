// Static SEED of the hosted render catalog — the offline/never-fetched
// fallback only. The live truth is GET /api/jobs/catalog (fetched into
// cloudCatalogStore on every account probe), so a shipped build picks up
// fleet/pricing changes without an app update. Keep the ids in sync with
// uselu apps/web/lib/render/cloud-models.ts when touching this file.

import type { RenderKind } from './cloud-jobs'

export interface CloudModel {
  id: string
  label: string
  kind: RenderKind
  /** Supports the masked img2img 'edit' op (flux-dev only today). */
  edit?: boolean
  /** Whether the hosted endpoint honours guidance_scale (CFG). */
  cfg?: boolean
  /** Whether the hosted endpoint honours negative_prompt. */
  negative_prompt?: boolean
  /** Video: clip lengths the model books (5s short / 8s long). */
  clip?: { short: number; long?: number }
  /** Per-run credit cost (base = image or 5s clip, long = 8s clip). */
  credits?: { base: number; long?: number }
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
  { id: 'wan-2.2-720p', label: 'Wan 2.2 720p', kind: 'video', negative_prompt: true, clip: CLIP },
  { id: 'wan-2.2-fast', label: 'Wan 2.2 Fast', kind: 'video', negative_prompt: true, clip: CLIP },
  { id: 'ltx-2', label: 'LTX-2 (with audio)', kind: 'video', clip: CLIP },
  { id: 'hunyuan-video', label: 'HunyuanVideo 1.5', kind: 'video', negative_prompt: true, clip: CLIP },
  { id: 'ltx-2.3', label: 'LTX 2.3', kind: 'video', clip: CLIP },
]
