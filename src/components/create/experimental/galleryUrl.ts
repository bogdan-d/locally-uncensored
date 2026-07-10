import { getImageUrl } from '../../../api/comfyui'
import { refreshResultUrl } from '../../../api/cloud/jobs'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'

/** Resolve a gallery item's display URL. Priority mirrors MediaViewer/Gallery:
 *  remoteUrl (cloud signed URL) → dataUrl (in-memory self-contained fallback)
 *  → ComfyUI /view path (filename/subfolder). */
export function galleryItemUrl(item: GalleryItem): string {
  return item.remoteUrl ?? item.dataUrl ?? getImageUrl(item.filename, item.subfolder)
}

// Cloud signed URLs expire ~1 h after the last read, so a persisted item's
// media errors on the next session. Re-sign lazily and patch the gallery
// entry so every surface re-renders with the fresh URL. The per-item guard
// stops an error → refresh → error loop when the job's file is gone for good
// (a successful re-sign yields a NEW URL each time, so onError would re-fire
// every cycle): after a success the item stays blocked for RESIGN_TTL_MS —
// long sessions can re-sign a second expiry — while a FAILED refresh (offline
// launch, transient 5xx) releases the guard so the next remount retries
// instead of leaving the media broken for the whole session.
const RESIGN_TTL_MS = 50 * 60_000
/** item.id → last successful re-sign epoch ms; 0 = refresh in flight. */
const recovered = new Map<string, number>()

export function recoverGalleryUrl(item: GalleryItem): void {
  if (!item.jobId) {
    // Local ComfyUI item whose /view fetch failed (engine not running /
    // output pruned) — nothing to re-sign. Flag it so the tiles can render
    // an honest "engine offline" state instead of a silently dead <img>.
    if (!item.unavailable) useCreateStore.getState().updateGalleryItem(item.id, { unavailable: true })
    return
  }
  const last = recovered.get(item.id)
  if (last !== undefined && (last === 0 || Date.now() - last < RESIGN_TTL_MS)) return
  recovered.set(item.id, 0)
  void refreshResultUrl(item.jobId).then((url) => {
    if (url) {
      recovered.set(item.id, Date.now())
      useCreateStore.getState().updateGalleryItem(item.id, { remoteUrl: url, unavailable: undefined })
    } else {
      recovered.delete(item.id)
    }
  })
}

/** Clear a tile's offline flag once its media actually loads (onLoad). */
export function markGalleryItemAvailable(item: GalleryItem): void {
  if (item.unavailable) useCreateStore.getState().updateGalleryItem(item.id, { unavailable: undefined })
}
