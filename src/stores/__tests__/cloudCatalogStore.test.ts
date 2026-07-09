import { describe, it, expect, beforeEach } from 'vitest'
import {
  useCloudCatalogStore,
  cloudModelsFor,
  defaultCloudModel,
  isEditCapable,
  cloudMediaLive,
} from '../cloudCatalogStore'
import { CLOUD_MODEL_SEED } from '../../lib/render/cloud-models'
import type { CloudCatalog } from '../../api/cloud/catalog'

const serverCatalog: CloudCatalog = {
  models: [
    { id: 'flux-9', label: 'Flux 9', kind: 'image', edit: true, cfg: true, credits: { base: 300 } },
    { id: 'wan-9', label: 'Wan 9', kind: 'video', clip: { short: 5, long: 8 }, credits: { base: 8000, long: 13000 } },
  ],
  ops: { removebg: 1000, eraser: 2500, upscale_image: 1000, upscale_video_per_s: 500, upscale_video_min: 2500 },
  voice: { stt: 600, tts_per_1k_chars: 8000 },
  media_live: false,
  tier: 'hosted-max',
  monthly_credits: 2_550_000,
}

beforeEach(() => {
  useCloudCatalogStore.setState({
    fetchedAt: null,
    models: CLOUD_MODEL_SEED,
    ops: null,
    voice: null,
    mediaLive: null,
  })
})

describe('cloudCatalogStore', () => {
  it('falls back to the static seed before any fetch', () => {
    expect(cloudModelsFor('image').length).toBeGreaterThan(0)
    expect(defaultCloudModel('image').id).toBe('flux-schnell')
    expect(defaultCloudModel('video').id).toBe('wan-2.2-720p')
    expect(isEditCapable('flux-dev')).toBe(true)
    expect(isEditCapable('flux-schnell')).toBe(false)
    // never fetched → unknown → treat as live (don't false-block)
    expect(cloudMediaLive()).toBe(true)
  })

  it('setCatalog replaces the seed with the server truth', () => {
    useCloudCatalogStore.getState().setCatalog(serverCatalog)
    expect(defaultCloudModel('image').id).toBe('flux-9')
    expect(defaultCloudModel('video').id).toBe('wan-9')
    expect(isEditCapable('flux-9')).toBe(true)
    expect(useCloudCatalogStore.getState().ops?.eraser).toBe(2500)
    expect(useCloudCatalogStore.getState().fetchedAt).not.toBeNull()
    // server said media is off → honest coming-soon
    expect(cloudMediaLive()).toBe(false)
  })

  it('seed ids match the wired flags (edit only on flux-dev, neg-prompt on wan/hunyuan)', () => {
    const editCapable = CLOUD_MODEL_SEED.filter((m) => m.edit).map((m) => m.id)
    expect(editCapable).toEqual(['flux-dev'])
    const negPrompt = CLOUD_MODEL_SEED.filter((m) => m.negative_prompt).map((m) => m.id)
    expect(negPrompt).toEqual(['wan-2.2-720p', 'wan-2.2-fast', 'hunyuan-video'])
  })
})
