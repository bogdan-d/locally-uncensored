// Save a displayed image/video to disk regardless of where it lives — ported
// from the web companion so the Create gallery downloads identically. A plain
// `<a download>` only works for same-origin/data URLs; cloud renders (signed
// Supabase URLs) are fetched into a Blob first. Last resort (fetch blocked):
// hand the URL to the system browser so the user can save manually.

import { openExternal } from '../api/backend'

export function mediaFilenameFromUrl(url: string, fallback = 'lu-render'): string {
  try {
    const path = new URL(url, typeof location !== 'undefined' ? location.origin : 'http://localhost').pathname
    const last = decodeURIComponent(path.split('/').pop() || '')
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last
  } catch { /* fall through */ }
  return fallback
}

function clickAnchor(href: string, filename: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

export async function downloadMediaUrl(url: string, filename?: string): Promise<void> {
  const name = filename && filename.length > 0 ? filename : mediaFilenameFromUrl(url)
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    clickAnchor(url, name)
    return
  }
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    const blob = await res.blob()
    const obj = URL.createObjectURL(blob)
    const finalName = filename && filename.length > 0
      ? filename
      : (res.url && res.url !== url ? mediaFilenameFromUrl(res.url, name) : name)
    clickAnchor(obj, finalName)
    setTimeout(() => URL.revokeObjectURL(obj), 30_000)
  } catch {
    void openExternal(url)
  }
}
