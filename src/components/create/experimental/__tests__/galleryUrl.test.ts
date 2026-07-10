import { describe, it, expect, vi, beforeEach } from 'vitest'

// zustand persist reads window.localStorage at store-module load (node env
// has no DOM) — same hoisted Map shim as createStore.test.ts.
vi.hoisted(() => {
  const map = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = ls
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  g.window = Object.assign(g.window ?? {}, { localStorage: ls })
})

vi.mock('../../../../api/comfyui', () => ({
  getImageUrl: vi.fn((filename: string, subfolder?: string) => `http://127.0.0.1:8188/view?filename=${filename}&subfolder=${subfolder ?? ''}`),
  classifyModel: vi.fn(() => 'unknown'),
}))
vi.mock('../../../../api/cloud/jobs', () => ({
  refreshResultUrl: vi.fn(),
}))

import { fetchGalleryItemBlob } from '../galleryUrl'
import { refreshResultUrl } from '../../../../api/cloud/jobs'
import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'

const baseItem: GalleryItem = {
  id: 'g1', filename: 'out.png', subfolder: '', type: 'image', prompt: '',
  negativePrompt: '', model: 'm', modelType: 'unknown', seed: 1, steps: 1,
  cfgScale: 1, sampler: 's', scheduler: 's', width: 8, height: 8,
  batchSize: 1, createdAt: 1,
} as GalleryItem

describe('fetchGalleryItemBlob', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useCreateStore.setState({ gallery: [] })
  })

  it('returns the blob when the primary URL answers', async () => {
    const blob = new Blob(['x'], { type: 'image/png' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => blob })))
    await expect(fetchGalleryItemBlob({ ...baseItem, remoteUrl: 'https://cdn/x.png' })).resolves.toBe(blob)
  })

  it('re-signs an expired cloud URL once and retries (the "failed to fetch" ops bug)', async () => {
    const blob = new Blob(['y'], { type: 'image/png' })
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, blob: async () => blob })
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(refreshResultUrl).mockResolvedValueOnce('https://cdn/fresh.png')
    const item = { ...baseItem, remoteUrl: 'https://cdn/expired.png', jobId: 'job-1' }
    useCreateStore.setState({ gallery: [item] })

    await expect(fetchGalleryItemBlob(item)).resolves.toBe(blob)
    expect(fetchMock).toHaveBeenLastCalledWith('https://cdn/fresh.png')
    // The gallery entry is patched so every surface re-renders with the fresh URL.
    expect(useCreateStore.getState().gallery[0].remoteUrl).toBe('https://cdn/fresh.png')
  })

  it('reports an honest error when the cloud copy is gone for good', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    vi.mocked(refreshResultUrl).mockResolvedValueOnce(null as unknown as string)
    await expect(fetchGalleryItemBlob({ ...baseItem, remoteUrl: 'https://cdn/x.png', jobId: 'job-2' }))
      .rejects.toThrow(/no longer available/)
  })

  it('explains the dead local ComfyUI /view URL instead of a bare TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(fetchGalleryItemBlob(baseItem)).rejects.toThrow(/ComfyUI/)
  })
})
