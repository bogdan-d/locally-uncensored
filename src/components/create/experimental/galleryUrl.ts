import { getImageUrl } from '../../../api/comfyui'
import { refreshResultUrl } from '../../../api/cloud/jobs'
import { fetchLocalhostBytes, isTauri } from '../../../api/backend'
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

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || ''
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return 'image/png'
}

/**
 * ComfyUI 0.19+ (portable, user-managed) blocks the WebView's cross-origin
 * `<video>`/`<img>` /view load with a Sec-Fetch-Site 403, while download +
 * history keep working because those ride the Rust proxy (no Origin header).
 * The user sees "can't view the result" even though the render exists (#75,
 * cinemazverev). Re-fetch the bytes THROUGH the proxy (no Origin → not blocked)
 * and hand back a blob: URL the element can display. Local items only — cloud
 * media has its own re-sign path (recoverGalleryUrl). Returns null when the
 * fallback doesn't apply or the proxy fetch fails.
 *
 * Tradeoff: a blob loads the whole clip into memory (no native Range/seek), so
 * this is a recovery path, not the default — the fast direct <video> stays in
 * use whenever ComfyUI allows the origin.
 */
export async function proxiedComfyBlobUrl(item: GalleryItem): Promise<string | null> {
  if (!isTauri() || item.jobId || item.remoteUrl || item.dataUrl) return null
  try {
    const bytes = await fetchLocalhostBytes(getImageUrl(item.filename, item.subfolder))
    return URL.createObjectURL(new Blob([bytes], { type: guessMime(item.filename) }))
  } catch {
    return null
  }
}

/** Fetch a gallery item's media bytes for adoption as an op source.
 *
 *  The naive `fetch(galleryItemUrl(item))` was the "failed to fetch" behind
 *  every source-needing op in cloud mode (David 2026-07-10): a cloud item's
 *  signed URL expires ~1 h after issue, and a local ComfyUI item's /view URL
 *  is dead whenever the local engine isn't running — both surface as a bare
 *  TypeError. Re-sign expired cloud media once via the job id, and turn the
 *  unrecoverable cases into actionable messages. */
export async function fetchGalleryItemBlob(item: GalleryItem): Promise<Blob> {
  const tryFetch = async (url: string) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`media request failed (${res.status})`)
    return res.blob()
  }
  try {
    return await tryFetch(galleryItemUrl(item))
  } catch (err) {
    if (item.jobId) {
      const fresh = await refreshResultUrl(item.jobId).catch(() => null)
      if (fresh) {
        useCreateStore.getState().updateGalleryItem(item.id, { remoteUrl: fresh, unavailable: undefined })
        return tryFetch(fresh)
      }
      throw new Error('The cloud copy of this render is no longer available — pick another image or upload one from disk.')
    }
    if (!item.remoteUrl && !item.dataUrl) {
      throw new Error('This image lives in your local ComfyUI output, which is not running right now — switch to Local (or start ComfyUI) to use it, or upload the file from disk.')
    }
    throw err
  }
}
