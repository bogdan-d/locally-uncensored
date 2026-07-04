// The hosted render fleet's model catalog (verbatim from uselu
// apps/web/lib/render/cloud-models.ts — keep in sync). Local backends list
// whatever the user installed; the cloud path renders on the operator's
// ComfyUI images, so the choice set is fixed and versioned here. `file` is
// the checkpoint name the worker's workflow templates load (%MODEL%); `id`
// is the stable slug the UI stores and the API accepts.

import type { RenderKind } from './cloud-jobs'

export interface CloudModel {
  id: string
  label: string
  kind: RenderKind
  file: string
}

export const CLOUD_MODELS: CloudModel[] = [
  {
    id: 'qwen-image-2512',
    label: 'Qwen Image 2512',
    kind: 'image',
    file: 'qwen_image_2512_fp8.safetensors',
  },
  {
    id: 'sdxl-base-1.0',
    label: 'SDXL 1.0',
    kind: 'image',
    file: 'sd_xl_base_1.0.safetensors',
  },
  {
    id: 'wan-2.2-a14b',
    label: 'Wan 2.2 A14B',
    kind: 'video',
    file: 'wan2.2_a14b_fp8.safetensors',
  },
]

export function cloudModelsFor(kind: RenderKind): CloudModel[] {
  return CLOUD_MODELS.filter((m) => m.kind === kind)
}

export function defaultCloudModel(kind: RenderKind): CloudModel {
  return cloudModelsFor(kind)[0]
}
