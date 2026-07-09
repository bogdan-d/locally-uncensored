// GET /api/jobs/catalog — the server-authoritative render/voice catalog
// (models, per-op credit costs, media-live switch). Pure HTTP; the persisted
// cache + fallback ordering live in stores/cloudCatalogStore.

import { cloudFetch, jsonOrError } from './client'
import type { CloudModel } from '../../lib/render/cloud-models'

export interface CatalogOps {
  removebg: number
  eraser: number
  upscale_image: number
  upscale_video_per_s: number
  upscale_video_min: number
}

export interface CloudCatalog {
  models: CloudModel[]
  ops: CatalogOps
  voice: { stt: number; tts_per_1k_chars: number }
  media_live: boolean
  tier: string
  monthly_credits: number
}

export async function getCatalog(): Promise<CloudCatalog> {
  const res = await cloudFetch('/api/jobs/catalog')
  return jsonOrError<CloudCatalog>(res)
}
