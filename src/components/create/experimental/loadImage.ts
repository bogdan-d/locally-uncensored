import { uploadImage } from '../../../api/comfyui'
import { useCreateStore } from '../../../stores/createStore'
import type { ImageRef } from '../../../stores/createStore'

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || 1024, height: img.naturalHeight || 1024 })
    img.onerror = () => resolve({ width: 1024, height: 1024 })
    img.src = url
  })
}

/** Containers the cloud upload accepts (uselu /api/jobs/upload sniffs magic
 *  bytes and 415s everything else). */
const UPLOAD_SAFE = /^image\/(png|jpe?g|webp)$/i

function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('the image could not be decoded — use PNG, JPG or WebP'))
    img.src = url
  })
}

/** File → ImageRef. Always reads a data URL for preview (and for the cloud
 *  path, which re-uploads from it at submit time). On the local backend the
 *  file is additionally uploaded to ComfyUI (/upload/image) to obtain the
 *  input/ filename the local workflow uses — on cloud there may be no
 *  ComfyUI at all, so that step is skipped and filename stays ''.
 *
 *  The backends only accept PNG/JPEG/WebP, but the WebView decodes more
 *  (HEIC on macOS — the iPhone default — AVIF, GIF): anything else the
 *  engine can decode is re-encoded to PNG via canvas, so the preview, the
 *  mask resolution and the upload all agree. Undecodable files throw an
 *  honest error instead of a server 415 after the prep work is done. */
export async function loadImageRef(file: File): Promise<ImageRef> {
  let upload: File = file
  let url = await readDataUrl(file)
  let width: number
  let height: number
  if (UPLOAD_SAFE.test(file.type)) {
    ;({ width, height } = await imageSize(url))
  } else {
    const img = await decodeImage(url)
    width = img.naturalWidth || 1024
    height = img.naturalHeight || 1024
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    url = canvas.toDataURL('image/png')
    const blob = await (await fetch(url)).blob()
    upload = new File([blob], file.name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' })
  }
  const backend = useCreateStore.getState().backend
  const filename = backend === 'cloud' ? '' : await uploadImage(upload)
  return { filename, url, width, height }
}

/** Backfill the ComfyUI filename for a ref picked while on the cloud backend
 *  (filename '') so switching cloud → local keeps edit/animate working. */
export async function ensureLocalFilename(ref: ImageRef, name: string): Promise<ImageRef> {
  if (ref.filename) return ref
  const blob = await (await fetch(ref.url)).blob()
  const filename = await uploadImage(new File([blob], name, { type: blob.type || 'image/png' }))
  return { ...ref, filename }
}
