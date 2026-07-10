// Persisted cache of GET /api/jobs/catalog — the hosted render/voice catalog.
// Refreshed on every successful account probe (useCloudAuth); offline or
// never-fetched falls back to the static CLOUD_MODEL_SEED so the Create UI
// always has a model list. Persist key is in AppShell's STORE_KEYS so the
// cache survives the NSIS-update WebView2 wipe like every other store.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { CLOUD_MODEL_SEED, type CloudModel } from '../lib/render/cloud-models'
import type { RenderKind, RenderOp } from '../lib/render/cloud-jobs'
import { getCatalog, type CatalogOps, type CloudCatalog } from '../api/cloud/catalog'

interface CloudCatalogState {
  fetchedAt: number | null
  models: CloudModel[]
  ops: CatalogOps | null
  voice: { stt: number; tts_per_1k_chars: number } | null
  /** null = unknown (never fetched) — treat as live so we don't false-block. */
  mediaLive: boolean | null

  setCatalog: (c: CloudCatalog) => void
}

export const useCloudCatalogStore = create<CloudCatalogState>()(
  persist(
    (set) => ({
      fetchedAt: null,
      models: CLOUD_MODEL_SEED,
      ops: null,
      voice: null,
      mediaLive: null,

      setCatalog: (c) =>
        set({
          fetchedAt: Date.now(),
          models: c.models,
          ops: c.ops,
          voice: c.voice,
          mediaLive: c.media_live,
        }),
    }),
    { name: 'lu-cloud-catalog' },
  ),
)

/** Fetch the live catalog into the store. Fire-and-forget on account probes —
 *  a failure just keeps the last persisted (or seed) catalog. */
export async function refreshCatalog(): Promise<void> {
  try {
    useCloudCatalogStore.getState().setCatalog(await getCatalog())
  } catch {
    // offline / gated — the persisted or seed catalog stays in effect
  }
}

export function cloudModelsFor(kind: RenderKind): CloudModel[] {
  return useCloudCatalogStore.getState().models.filter((m) => m.kind === kind)
}

export function defaultCloudModel(kind: RenderKind): CloudModel {
  return cloudModelsFor(kind)[0]
}

export function cloudModelById(id: string): CloudModel | undefined {
  return useCloudCatalogStore.getState().models.find((m) => m.id === id)
}

export function isEditCapable(id: string): boolean {
  return cloudModelById(id)?.edit === true
}

/** First edit-capable image model in the catalog (flux-dev today) — the
 *  submit-time fallback when the picker holds a t2i-only model for an edit. */
export function defaultEditModel(): CloudModel | undefined {
  return useCloudCatalogStore.getState().models.find((m) => m.kind === 'image' && m.edit)
}

/** Credits the upcoming run draws, priced from the server catalog: per-op
 *  utility rates, per-model base/long clip rates (the long rate books from
 *  ~6.5 s, mirroring the server's mediaCredits split). Edit coerces onto the
 *  edit-capable model exactly like useCloudCreate's submit, so gate + meter
 *  price the model the run actually uses. Falls back to the quota's
 *  representative per-kind figure when the catalog carries no price
 *  (seed/offline). */
export function runCredits(
  kind: RenderKind,
  op: RenderOp,
  pickedModel: string,
  seconds: number | undefined,
  fallback: number,
  resolution?: string,
): number {
  const { ops } = useCloudCatalogStore.getState()
  if (op === 'removebg' || op === 'eraser' || op === 'upscale') {
    const upscale =
      ops && kind === 'image'
        ? ((resolution && ops.upscale_image_res?.[resolution]) || ops.upscale_image)
        : ops?.upscale_image
    const rate = ops ? { removebg: ops.removebg, eraser: ops.eraser, upscale }[op] : undefined
    return rate ?? fallback
  }
  const model =
    op === 'edit' && !isEditCapable(pickedModel) ? (defaultEditModel()?.id ?? pickedModel) : pickedModel
  const credits = cloudModelById(model)?.credits
  if (!credits) return fallback
  return kind === 'video' && seconds !== undefined && seconds >= 6.5
    ? (credits.long ?? credits.base)
    : credits.base
}

/** Media-live switch from the server (MEDIA_LIVE env). Unknown = live so the
 *  first-ever session doesn't false-block before the catalog arrives. */
export function cloudMediaLive(): boolean {
  return useCloudCatalogStore.getState().mediaLive !== false
}
