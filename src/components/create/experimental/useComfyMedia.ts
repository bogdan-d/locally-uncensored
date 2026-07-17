import { useState, useEffect, useRef, useCallback } from 'react'
import { galleryItemUrl, proxiedComfyBlobUrl, recoverGalleryUrl, markGalleryItemAvailable } from './galleryUrl'
import { isComfyLocal } from '../../../api/backend'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'

/**
 * Display src for a gallery item's `<img>`/`<video>` with a ComfyUI-0.19+
 * cross-origin fallback (#75). The direct /view load is fast but a user-managed
 * ComfyUI ≥0.19 answers the WebView's cross-origin request with a Sec-Fetch 403
 * (video especially — its Range requests carry an Origin), so the element errors
 * even though the render exists. On that error we re-fetch the bytes through the
 * Rust proxy (no Origin header → not blocked) and swap to a blob: URL, and flag
 * `comfyCorsBlocked` so the tab can surface the exact --enable-cors-header fix.
 * Only if the proxy ALSO fails do we fall back to the "engine offline" state.
 */
export function useComfyMedia(item: GalleryItem | null) {
  const base = item ? galleryItemUrl(item) : ''
  const [src, setSrc] = useState(base)
  const blobRef = useRef<string | null>(null)
  const triedProxy = useRef(false)

  // Reset when the underlying URL changes (e.g. a cloud re-sign swaps remoteUrl).
  useEffect(() => {
    triedProxy.current = false
    if (blobRef.current) {
      URL.revokeObjectURL(blobRef.current)
      blobRef.current = null
    }
    setSrc(base)
  }, [base])

  // Release the blob when the element unmounts.
  useEffect(() => () => {
    if (blobRef.current) URL.revokeObjectURL(blobRef.current)
  }, [])

  const onError = useCallback(() => {
    if (!item) return
    if (triedProxy.current) {
      recoverGalleryUrl(item)
      return
    }
    triedProxy.current = true
    void proxiedComfyBlobUrl(item).then((blob) => {
      if (blob) {
        blobRef.current = blob
        setSrc(blob)
        // Proxy rescued a /view the direct load couldn't reach. On a LOCAL
        // host that means ComfyUI 0.19+ rejected the cross-origin load and
        // the --enable-cors-header hint is actionable. On a REMOTE host
        // (#82, rx422) the block is LU's own CSP — expected, by design — and
        // the CORS hint would be wrong (the flag can't unblock a CSP'd
        // <img>), so the proxy path is simply the normal mode: no banner.
        if (isComfyLocal()) useCreateStore.getState().setComfyCorsBlocked(true)
      } else {
        recoverGalleryUrl(item)
      }
    })
  }, [item])

  const onLoad = useCallback(() => { if (item) markGalleryItemAvailable(item) }, [item])

  return { src, onError, onLoad }
}
