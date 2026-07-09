import { getImageUrl } from '../../../api/comfyui'
import type { GalleryItem } from '../../../stores/createStore'

/** Resolve a gallery item's display URL. Priority mirrors MediaViewer/Gallery:
 *  remoteUrl (cloud signed URL) → dataUrl (MLX self-contained PNG) → ComfyUI
 *  /view path (filename/subfolder). */
export function galleryItemUrl(item: GalleryItem): string {
  return item.remoteUrl ?? item.dataUrl ?? getImageUrl(item.filename, item.subfolder)
}
