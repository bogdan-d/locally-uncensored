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
// media errors on the next session. Re-sign once per item per session (the
// guard stops an error → refresh → error loop when the job's file is gone
// for good) and patch the gallery entry so every surface re-renders with
// the fresh URL.
const recovered = new Set<string>()

export function recoverGalleryUrl(item: GalleryItem): void {
  if (!item.jobId || recovered.has(item.id)) return
  recovered.add(item.id)
  void refreshResultUrl(item.jobId).then((url) => {
    if (url) useCreateStore.getState().updateGalleryItem(item.id, { remoteUrl: url })
  })
}
