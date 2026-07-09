// Persisted cache of GET /api/jobs/catalog — the hosted render/voice catalog.
// Refreshed on every successful account probe (useCloudAuth); offline or
// never-fetched falls back to the static CLOUD_MODEL_SEED so the Create UI
// always has a model list. Persist key is in AppShell's STORE_KEYS so the
// cache survives the NSIS-update WebView2 wipe like every other store.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { CLOUD_MODEL_SEED, type CloudModel } from '../lib/render/cloud-models'
import type { RenderKind } from '../lib/render/cloud-jobs'
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

/** Media-live switch from the server (MEDIA_LIVE env). Unknown = live so the
 *  first-ever session doesn't false-block before the catalog arrives. */
export function cloudMediaLive(): boolean {
  return useCloudCatalogStore.getState().mediaLive !== false
}
