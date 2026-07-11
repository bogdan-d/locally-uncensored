import { describe, it, expect, beforeEach } from 'vitest'
import {
  useCloudCatalogStore,
  cloudModelsFor,
  defaultCloudModel,
  defaultEditModel,
  isEditCapable,
  cloudMediaLive,
  runCredits,
  t2vModels,
  i2vModels,
  modelForOp,
} from '../cloudCatalogStore'
import { CLOUD_MODEL_SEED } from '../../lib/render/cloud-models'
import type { CloudCatalog } from '../../api/cloud/catalog'

const serverCatalog: CloudCatalog = {
  models: [
    { id: 'flux-9', label: 'Flux 9', kind: 'image', edit: true, cfg: true, credits: { base: 300 } },
    { id: 'wan-9', label: 'Wan 9', kind: 'video', clip: { short: 5, long: 8 }, credits: { base: 8000, long: 13000 } },
  ],
  ops: {
    removebg: 1000,
    eraser: 2500,
    upscale_image: 1000,
    upscale_image_res: { '2k': 1000, '4k': 1000, '8k': 4000 },
    upscale_video_per_s: 500,
    upscale_video_min: 2500,
  },
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

  it('defaultEditModel resolves the first edit-capable image model (seed and server)', () => {
    expect(defaultEditModel()?.id).toBe('flux-dev')
    useCloudCatalogStore.getState().setCatalog(serverCatalog)
    expect(defaultEditModel()?.id).toBe('flux-9')
  })

  describe('runCredits', () => {
    it('falls back to the quota figure before any catalog fetch (seed has no prices)', () => {
      expect(runCredits('image', 'generate', 'flux-schnell', undefined, 300)).toBe(300)
      expect(runCredits('image', 'eraser', 'flux-schnell', undefined, 300)).toBe(300)
    })

    it('prices utility ops from the catalog ops table', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      expect(runCredits('image', 'removebg', 'flux-9', undefined, 300)).toBe(1000)
      expect(runCredits('image', 'eraser', 'flux-9', undefined, 300)).toBe(2500)
      expect(runCredits('image', 'upscale', 'flux-9', undefined, 300)).toBe(1000)
    })

    it('prices video upscale per second with the min floor and the server 8s default', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      // unknown clip length → server default 8 s → 500 × 8 = 4000 (what the submit claims)
      expect(runCredits('video', 'upscale', 'wan-9', undefined, 300)).toBe(4000)
      expect(runCredits('video', 'upscale', 'wan-9', 10, 300)).toBe(5000)
      // short clip books the floor
      expect(runCredits('video', 'upscale', 'wan-9', 3, 300)).toBe(2500)
      // no catalog → quota fallback
      useCloudCatalogStore.setState({ ops: null })
      expect(runCredits('video', 'upscale', 'wan-9', undefined, 300)).toBe(300)
    })

    it('prices image upscale per target resolution, flat 4k when the res table is absent', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      expect(runCredits('image', 'upscale', 'flux-9', undefined, 300, '8k')).toBe(4000)
      expect(runCredits('image', 'upscale', 'flux-9', undefined, 300, '2k')).toBe(1000)
      // Older persisted catalog without the res table → flat 4k figure.
      useCloudCatalogStore.getState().setCatalog({
        ...serverCatalog,
        ops: { ...serverCatalog.ops, upscale_image_res: undefined },
      })
      expect(runCredits('image', 'upscale', 'flux-9', undefined, 300, '8k')).toBe(1000)
    })

    it('prices generates per model, booking the long clip rate from 6.5 s', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      expect(runCredits('image', 'generate', 'flux-9', undefined, 300)).toBe(300)
      expect(runCredits('video', 'generate', 'wan-9', 5, 40000)).toBe(8000)
      expect(runCredits('video', 'generate', 'wan-9', 8, 40000)).toBe(13000)
    })

    it('edit coerces onto the edit-capable model like the submit does', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      expect(runCredits('image', 'edit', 'some-t2i-only', undefined, 999)).toBe(300)
    })

    it('unknown model falls back to the quota figure', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      expect(runCredits('image', 'generate', 'not-in-catalog', undefined, 321)).toBe(321)
    })
  })

  describe('video capability flags (t2v / i2v)', () => {
    const mixed: CloudCatalog = {
      ...serverCatalog,
      models: [
        { id: 'flux-9', label: 'Flux 9', kind: 'image', edit: true },
        { id: 'dual', label: 'Dual', kind: 'video', t2v: true, i2v: true },
        { id: 't2v-only', label: 'T2V only', kind: 'video', t2v: true, i2v: false },
        { id: 'legacy', label: 'Legacy (no flags)', kind: 'video' },
      ],
    }

    it('every seed clip model does both t2v and i2v', () => {
      const vids = CLOUD_MODEL_SEED.filter((m) => m.kind === 'video')
      expect(vids.length).toBeGreaterThan(0)
      expect(vids.every((m) => m.t2v !== false && m.i2v !== false)).toBe(true)
    })

    it('i2vModels excludes an i2v:false model; an absent flag stays capable', () => {
      useCloudCatalogStore.getState().setCatalog(mixed)
      expect(i2vModels().map((m) => m.id)).toEqual(['dual', 'legacy'])
      expect(t2vModels().map((m) => m.id)).toEqual(['dual', 't2v-only', 'legacy'])
    })

    it('modelForOp coerces an incapable pick onto the op’s first valid model', () => {
      useCloudCatalogStore.getState().setCatalog(mixed)
      // animate with a t2v-only pick → first i2v-capable clip model
      expect(modelForOp('video', 'animate', 't2v-only')).toBe('dual')
      // a capable pick is kept untouched
      expect(modelForOp('video', 'animate', 'legacy')).toBe('legacy')
      expect(modelForOp('video', 'generate', 't2v-only')).toBe('t2v-only')
      // edit still coerces onto the edit-capable image model
      expect(modelForOp('image', 'edit', 'dual')).toBe('flux-9')
      // a non-video, non-edit op keeps the pick
      expect(modelForOp('image', 'generate', 'flux-9')).toBe('flux-9')
    })
  })
})
