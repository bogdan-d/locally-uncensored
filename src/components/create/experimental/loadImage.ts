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

/** File → ImageRef. Always reads a data URL for preview (and for the cloud
 *  path, which re-uploads from it at submit time). On the local backend the
 *  file is additionally uploaded to ComfyUI (/upload/image) to obtain the
 *  input/ filename the local workflow uses — on cloud there may be no
 *  ComfyUI at all, so that step is skipped and filename stays ''. */
export async function loadImageRef(file: File): Promise<ImageRef> {
  const url = await readDataUrl(file)
  const { width, height } = await imageSize(url)
  const backend = useCreateStore.getState().backend
  const filename = backend === 'cloud' ? '' : await uploadImage(file)
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
