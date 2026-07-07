// The hosted render fleet's model catalog (keep in sync with uselu
// apps/web/lib/render/cloud-models.ts — the desktop cloud tier submits to the
// same lu-labs.ai backend, so these ids must match what it accepts). The cloud
// path renders on WaveSpeed's hosted endpoints; `file` is unused on the desktop
// (kept only for parity with the web catalog shape).

import type { RenderKind } from './cloud-jobs'

export interface CloudModel {
  id: string
  label: string
  kind: RenderKind
  file?: string
}

export const CLOUD_MODELS: CloudModel[] = [
  { id: 'flux-schnell', label: 'Flux Schnell (fast)', kind: 'image', file: 'flux1-schnell-fp8.safetensors' },
  { id: 'flux-dev', label: 'Flux Dev (quality)', kind: 'image', file: 'flux1-dev-fp8.safetensors' },
  { id: 'flux-1.1-pro', label: 'Flux 1.1 Pro', kind: 'image', file: 'flux1.1-pro.safetensors' },
  { id: 'qwen-image', label: 'Qwen Image', kind: 'image', file: 'qwen_image_fp8.safetensors' },
  { id: 'seedream-v4', label: 'Seedream 4', kind: 'image', file: 'seedream_v4.safetensors' },
  { id: 'hidream', label: 'HiDream', kind: 'image', file: 'hidream_i1_dev.safetensors' },
  { id: 'wan-2.2-720p', label: 'Wan 2.2 720p', kind: 'video', file: 'wan2.2_a14b_fp8.safetensors' },
  { id: 'wan-2.2-fast', label: 'Wan 2.2 Fast', kind: 'video', file: 'wan2.2_5b_fp8.safetensors' },
  // Premium hosted video menu (2026-07-07), cheap → pricey; wan stays first so
  // the default video model keeps the lowest per-clip cost.
  { id: 'seedance-lite', label: 'Seedance Lite', kind: 'video' },
  { id: 'hailuo-2.3', label: 'Hailuo 2.3', kind: 'video' },
  { id: 'seedance-pro', label: 'Seedance Pro', kind: 'video' },
  { id: 'hailuo-2.3-pro', label: 'Hailuo 2.3 Pro (1080p)', kind: 'video' },
  { id: 'kling-turbo', label: 'Kling Turbo (720p)', kind: 'video' },
  { id: 'kling-turbo-pro', label: 'Kling Turbo Pro (1080p)', kind: 'video' },
  { id: 'veo-3.1-fast', label: 'Veo 3.1 Fast (Audio)', kind: 'video' },
  { id: 'veo-3.1', label: 'Veo 3.1 (Audio)', kind: 'video' },
]

export function cloudModelsFor(kind: RenderKind): CloudModel[] {
  return CLOUD_MODELS.filter((m) => m.kind === kind)
}

export function defaultCloudModel(kind: RenderKind): CloudModel {
  return cloudModelsFor(kind)[0]
}
