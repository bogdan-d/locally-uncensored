import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModelType, ClassifiedModel } from '../api/comfyui'
import { classifyModel } from '../api/comfyui'
import type { PreflightError } from '../api/preflight'
// ModelType includes: flux, flux2, zimage, sdxl, sd15, wan, hunyuan, unknown

export type ProgressPhase = 'idle' | 'queued' | 'loading-model' | 'loading-clip' | 'loading-vae' | 'sampling' | 'decoding' | 'complete'

/**
 * Backend the redesigned Create page generates against. Runtime-only — derived
 * from session/license (a paired Bridge → `local`; a logged-in hosted tier →
 * `cloud`) and never persisted. Orthogonal to `videoBackend` (comfy|mlx), which
 * stays a local-only concern.
 */
export type CreateBackend = 'local' | 'cloud'

/**
 * The redesigned Create page's flat creation intents, derived over
 * mode / image sub-mode / video sub-mode / removebg. The `mode` + sub-mode
 * enums stay the load-bearing state; `intent` is a derived view over them.
 */
export type CreateIntent = 'image' | 'edit' | 'removebg' | 'video' | 'animate' | 'upscale' | 'eraser'

/** Cloud-only single-purpose WaveSpeed endpoints (2.5.7): super-resolution
 *  and masked object removal. Local backends have no lane for them, so the
 *  IntentBar only offers these while the cloud backend is active. */
export type UtilityOp = 'upscale' | 'eraser'

/**
 * A source or mask image loaded into the Stage input slot. `filename` is the
 * backend handle (a ComfyUI /upload/image name on the local path, or a
 * render-inputs storage path on the cloud path); `url` is a local object/data
 * URL for preview. Runtime-only — never persisted.
 */
export interface ImageRef { filename: string; url: string; width: number; height: number }

/** Flatten mode / sub-mode / removebg / utilityOp into the single intent the
 *  UI drives. */
export function deriveIntent(s: {
  removebg: boolean
  utilityOp: UtilityOp | null
  mode: 'image' | 'video'
  imageSubMode: 'text2img' | 'img2img'
  videoSubMode: 't2v' | 'i2v'
}): CreateIntent {
  if (s.removebg) return 'removebg'
  if (s.utilityOp) return s.utilityOp
  if (s.mode === 'video') return s.videoSubMode === 'i2v' ? 'animate' : 'video'
  return s.imageSubMode === 'img2img' ? 'edit' : 'image'
}

/**
 * Where video generation runs.
 *
 * - `comfy` — local ComfyUI server. Works on every OS; FP8 quirks on Mac
 *   MPS, fastest on CUDA. Default for Windows + Linux.
 *
 * - `mlx` — `mlx-video` subprocess driven by the Bridge. Apple Silicon
 *   only, uses Apple's MLX framework against unified memory. Faster than
 *   ComfyUI-on-MPS for the models it supports (Wan 2.2, LTX-2). Default
 *   for Apple Silicon Macs with ≥32 GB unified memory.
 */
export type VideoBackendKind = 'comfy' | 'mlx'

// ─── Optimal defaults per model type (research-backed: Draw Things, Fooocus, ComfyUI) ───

export const MODEL_TYPE_DEFAULTS: Record<ModelType, {
  steps: number; cfgScale: number; sampler: string; scheduler: string
  width: number; height: number; frames?: number; fps?: number
}> = {
  sd15:        { steps: 25, cfgScale: 7.0, sampler: 'euler_ancestral', scheduler: 'normal', width: 512,  height: 512 },
  sdxl:        { steps: 25, cfgScale: 7.0, sampler: 'dpmpp_2m',       scheduler: 'karras', width: 1024, height: 1024 },
  flux:        { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  flux2:       { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  zimage:      { steps: 12, cfgScale: 3.5, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  ernie_image: { steps: 20, cfgScale: 4.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  wan:         { steps: 25, cfgScale: 5.0, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 49, fps: 16 },
  wan22:       { steps: 30, cfgScale: 5.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 576, frames: 49, fps: 24 },
  hunyuan:     { steps: 30, cfgScale: 6.0, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 45, fps: 15 },
  ltx:         { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 768,  height: 512, frames: 97, fps: 24 },
  mochi:       { steps: 40, cfgScale: 4.5, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 49, fps: 24 },
  cosmos:      { steps: 30, cfgScale: 7.0, sampler: 'euler',           scheduler: 'normal', width: 1280, height: 704, frames: 57, fps: 24 },
  cogvideo:    { steps: 50, cfgScale: 6.0, sampler: 'euler',           scheduler: 'normal', width: 720,  height: 480, frames: 49, fps: 8  },
  svd:         { steps: 25, cfgScale: 2.5, sampler: 'euler',           scheduler: 'karras', width: 1024, height: 576, frames: 25, fps: 6  },
  framepack:   { steps: 30, cfgScale: 5.0, sampler: 'euler',           scheduler: 'normal', width: 832,  height: 480, frames: 33, fps: 16 },
  pyramidflow: { steps: 20, cfgScale: 7.0, sampler: 'euler',           scheduler: 'normal', width: 1280, height: 768, frames: 121, fps: 24 },
  allegro:     { steps: 100, cfgScale: 7.5, sampler: 'euler',          scheduler: 'normal', width: 1280, height: 720, frames: 88, fps: 15 },
  unknown:     { steps: 20, cfgScale: 7.0, sampler: 'euler',           scheduler: 'normal', width: 1024, height: 1024 },
}

export interface GalleryItem {
  id: string
  type: 'image' | 'video'
  filename: string
  subfolder: string
  prompt: string
  negativePrompt: string
  model: string
  modelType: ModelType
  seed: number
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
  width: number
  height: number
  batchSize: number
  createdAt: number
  builderUsed?: 'dynamic' | 'legacy' | 'custom'
  resolvedVAE?: string
  resolvedCLIP?: string
  /** Self-contained PNG data URL for backends that don't serve files over
   *  ComfyUI's /view route (e.g. MLX on Apple Silicon). When set, display +
   *  download read from this instead of filename/subfolder. In-memory only —
   *  partialize strips it so media bytes never hit the localStorage quota. */
  dataUrl?: string
  /** Cloud jobs: signed result URL from the render queue. Display prefers
   *  `remoteUrl` → `dataUrl` → the ComfyUI /view path (filename/subfolder). */
  remoteUrl?: string
  /** Cloud jobs: TEE attestation receipt (null on non-attested lanes). */
  attestation?: { quote: string; verify_url: string } | null
  /** Cloud jobs: the render_jobs id, so the client can re-poll/re-sign. */
  jobId?: string
  /** Which redesign intent produced this item (gallery tagging). */
  intent?: CreateIntent
  /** Runtime-only (stripped by partialize): the item's media failed to load
   *  and can't be recovered right now — a local ComfyUI item while the engine
   *  is unreachable. Tiles render an honest offline state and Download
   *  disables instead of silently no-oping. */
  unavailable?: boolean
}

interface CreateState {
  mode: 'image' | 'video'
  videoBackend: VideoBackendKind
  /** Set once auto-detect has run (or the user clicked the backend picker)
   *  so we don't keep overriding their choice on every launch. */
  videoBackendInitialized: boolean
  imageSubMode: 'text2img' | 'img2img'
  prompt: string
  negativePrompt: string
  imageModel: string
  imageModelType: ModelType
  videoModel: string
  sampler: string
  scheduler: string
  steps: number
  cfgScale: number
  width: number
  height: number
  seed: number
  batchSize: number
  frames: number
  fps: number
  denoise: number  // Denoise strength for I2I (0.0–1.0)
  i2iImage: string | null  // Uploaded image filename for I2I
  i2vImage: string | null  // Uploaded image filename for I2V models (SVD, FramePack)

  // ── redesign additions: flat-intent model + unified inputs + extra params ──
  videoSubMode: 't2v' | 'i2v'
  removebg: boolean
  /** Cloud-only utility intents (upscale/eraser); null = normal generate axis. */
  utilityOp: UtilityOp | null
  /** Upscale target for the cloud super-resolution endpoint. */
  targetResolution: '2k' | '4k' | '8k'
  showNegative: boolean
  selectedLoras: { name: string; strength: number }[]
  selectedVae: string
  clipSkip: number
  growMaskBy: number  // inpaint mask edge feather (VAEEncodeForInpaint grow_mask_by)
  /** Unified Stage input slot (runtime-only). On the local path source.filename
   *  maps to i2iImage/i2vImage; on the cloud path it is a render-inputs path. */
  source: ImageRef | null
  sourceSetAt: number
  mask: ImageRef | null
  /** Runtime-only: local (Bridge) vs cloud (/api/jobs), derived from session. */
  backend: CreateBackend
  /** Runtime-only: hosted model slugs (lib/render/cloud-models) for the cloud
   *  backend — separate from the persisted local checkpoint names. */
  cloudImageModel: string
  cloudVideoModel: string
  /** Runtime-only: which local custom-node capabilities are installed. */
  caps: Record<'rmbg' | 'inpaint-nodes', boolean>

  isGenerating: boolean
  progress: number
  progressText: string
  progressPhase: ProgressPhase
  currentPromptId: string | null
  error: string | null
  lastGenTime: string | null
  preflightReady: boolean | null
  preflightErrors: PreflightError[]
  preflightWarnings: string[]
  gallery: GalleryItem[]
  promptHistory: string[]
  /** Runtime-only (not persisted): populated by useCreate.fetchModels so the
   * header-level CreateTopControls can render its model dropdown + Lichtschalter
   * without hosting its own ComfyUI fetching. */
  imageModelList: ClassifiedModel[]
  videoModelList: ClassifiedModel[]
  comfyRunning: boolean
  /** Bug A (v2.4.5) + #72 (bob): resolver for the VHS_VideoCombine install
   *  prompt. Runtime-only — useCreate sets it when a video gen would fall
   *  back to animated .webp; the modal resolves with the user's choice. */
  vhsInstallPrompt: ((choice: 'install' | 'webp' | 'cancel') => void) | null

  setPreflightStatus: (ready: boolean | null, errors: PreflightError[], warnings: string[]) => void
  setMode: (mode: 'image' | 'video') => void
  setVideoBackend: (backend: VideoBackendKind) => void
  setImageSubMode: (subMode: 'text2img' | 'img2img') => void
  setPrompt: (prompt: string) => void
  setNegativePrompt: (negativePrompt: string) => void
  setImageModel: (model: string, type: ModelType) => void
  setVideoModel: (model: string) => void
  setSampler: (sampler: string) => void
  setScheduler: (scheduler: string) => void
  setSteps: (steps: number) => void
  setCfgScale: (cfgScale: number) => void
  setSize: (width: number, height: number) => void
  setSeed: (seed: number) => void
  setBatchSize: (batchSize: number) => void
  setFrames: (frames: number) => void
  setFps: (fps: number) => void
  setDenoise: (denoise: number) => void
  setI2iImage: (image: string | null) => void
  setI2vImage: (image: string | null) => void

  // ── redesign additions ──
  intent: () => CreateIntent
  setIntent: (intent: CreateIntent) => void
  toggleNegative: () => void
  toggleLora: (name: string) => void
  setLoraStrengthFor: (name: string, strength: number) => void
  clearLoras: () => void
  setSelectedVae: (name: string) => void
  setClipSkip: (n: number) => void
  setGrowMaskBy: (n: number) => void
  setTargetResolution: (r: '2k' | '4k' | '8k') => void
  setSource: (img: ImageRef | null) => void
  setMask: (img: ImageRef | null) => void
  setBackend: (backend: CreateBackend) => void
  setCloudImageModel: (id: string) => void
  setCloudVideoModel: (id: string) => void
  setCaps: (caps: Record<'rmbg' | 'inpaint-nodes', boolean>) => void
  resetParamsToModelDefaults: () => void

  setIsGenerating: (generating: boolean) => void
  setProgress: (progress: number, text?: string) => void
  setProgressPhase: (phase: ProgressPhase) => void
  setCurrentPromptId: (id: string | null) => void
  setVhsInstallPrompt: (resolver: ((choice: 'install' | 'webp' | 'cancel') => void) | null) => void
  setError: (error: string | null) => void
  setLastGenTime: (time: string | null) => void
  addToGallery: (item: GalleryItem) => void
  /** Patch a gallery item in place (e.g. a lazily re-signed remoteUrl). */
  updateGalleryItem: (id: string, patch: Partial<GalleryItem>) => void
  removeFromGallery: (id: string) => void
  clearGallery: () => void
  addToPromptHistory: (prompt: string) => void
  setImageModelList: (list: ClassifiedModel[]) => void
  setVideoModelList: (list: ClassifiedModel[]) => void
  setComfyRunning: (running: boolean) => void
}

export const useCreateStore = create<CreateState>()(
  persist(
    // Explicit param/return types: LU compiles with `strict: true` (the web
    // repo does not), and zustand v5's persist loses contextual typing of the
    // state-creator there — annotating restores set/get and setter types.
    (
      set: (p: Partial<CreateState> | ((s: CreateState) => Partial<CreateState>)) => void,
      get: () => CreateState,
    ): CreateState => ({
      mode: 'image',
      // Default to ComfyUI; AppShell/Onboarding flips this to 'mlx' on
      // Apple Silicon Macs with enough RAM after the bridge reports
      // arch + memory. Persisted across sessions so the auto-detect only
      // runs once.
      videoBackend: 'comfy' as VideoBackendKind,
      videoBackendInitialized: false,
      imageSubMode: 'text2img' as 'text2img' | 'img2img',
      prompt: '',
      negativePrompt: '',
      imageModel: '',
      imageModelType: 'unknown' as ModelType,
      videoModel: '',
      sampler: 'euler',
      scheduler: 'normal',
      steps: 20,
      cfgScale: 7,
      width: 1024,
      height: 1024,
      seed: -1,
      batchSize: 1,
      frames: 24,
      fps: 8,
      denoise: 0.7,
      i2iImage: null,
      i2vImage: null,

      // ── redesign additions ──
      videoSubMode: 't2v' as 't2v' | 'i2v',
      removebg: false,
      utilityOp: null as UtilityOp | null,
      targetResolution: '4k' as '2k' | '4k' | '8k',
      showNegative: false,
      selectedLoras: [] as { name: string; strength: number }[],
      selectedVae: 'auto',
      clipSkip: 0,
      growMaskBy: 6,
      source: null as ImageRef | null,
      sourceSetAt: 0,
      mask: null as ImageRef | null,
      backend: 'local' as CreateBackend,
      cloudImageModel: '',
      cloudVideoModel: '',
      caps: { rmbg: false, 'inpaint-nodes': false } as Record<'rmbg' | 'inpaint-nodes', boolean>,

      isGenerating: false,
      progress: 0,
      progressText: '',
      progressPhase: 'idle' as ProgressPhase,
      currentPromptId: null,
      error: null,
      lastGenTime: null,
      preflightReady: null,
      preflightErrors: [],
      preflightWarnings: [],
      gallery: [],
      promptHistory: [],
      imageModelList: [],
      videoModelList: [],
      comfyRunning: false,
      vhsInstallPrompt: null,

      setPreflightStatus: (ready, errors, warnings) => set({ preflightReady: ready, preflightErrors: errors, preflightWarnings: warnings }),
      setVideoBackend: (videoBackend) => set({ videoBackend, videoBackendInitialized: true }),
      setMode: (mode) => set((state) => {
        // Reset parameters to the correct defaults when switching modes
        // This prevents image resolution (1024x1024) leaking into video mode (causes HTTP 500)
        if (mode === 'video' && state.videoModel) {
          const type = classifyModel(state.videoModel)
          const defaults = MODEL_TYPE_DEFAULTS[type] || MODEL_TYPE_DEFAULTS.unknown
          return {
            mode,
            steps: defaults.steps, cfgScale: defaults.cfgScale,
            sampler: defaults.sampler, scheduler: defaults.scheduler,
            width: defaults.width, height: defaults.height,
            ...(defaults.frames ? { frames: defaults.frames } : {}),
            ...(defaults.fps ? { fps: defaults.fps } : {}),
          }
        }
        if (mode === 'image' && state.imageModel) {
          const defaults = MODEL_TYPE_DEFAULTS[state.imageModelType] || MODEL_TYPE_DEFAULTS.unknown
          return {
            mode,
            steps: defaults.steps, cfgScale: defaults.cfgScale,
            sampler: defaults.sampler, scheduler: defaults.scheduler,
            width: defaults.width, height: defaults.height,
          }
        }
        return { mode }
      }),
      setImageSubMode: (subMode) => set({ imageSubMode: subMode }),
      setPrompt: (prompt) => set({ prompt }),
      setNegativePrompt: (negativePrompt) => set({ negativePrompt }),
      setImageModel: (model, type) => {
        const defaults = MODEL_TYPE_DEFAULTS[type]
        set({
          imageModel: model, imageModelType: type,
          steps: defaults.steps, cfgScale: defaults.cfgScale,
          sampler: defaults.sampler, scheduler: defaults.scheduler,
          width: defaults.width, height: defaults.height,
        })
      },
      setVideoModel: (model) => {
        const type = classifyModel(model)
        const defaults = MODEL_TYPE_DEFAULTS[type] || MODEL_TYPE_DEFAULTS.unknown
        set({
          videoModel: model,
          steps: defaults.steps, cfgScale: defaults.cfgScale,
          sampler: defaults.sampler, scheduler: defaults.scheduler,
          width: defaults.width, height: defaults.height,
          ...(defaults.frames ? { frames: defaults.frames } : {}),
          ...(defaults.fps ? { fps: defaults.fps } : {}),
        })
      },
      setSampler: (sampler) => set({ sampler }),
      setScheduler: (scheduler) => set({ scheduler }),
      setSteps: (steps) => set({ steps: Math.max(1, Math.min(200, Math.floor(steps))) }),
      setCfgScale: (cfgScale) => set({ cfgScale: Math.max(0, Math.min(30, cfgScale)) }),
      setSize: (width, height) => set({
        width: Math.max(64, Math.min(4096, Math.floor(width))),
        height: Math.max(64, Math.min(4096, Math.floor(height))),
      }),
      setSeed: (seed) => set({ seed: Math.floor(seed) }),
      setBatchSize: (batchSize) => set({ batchSize: Math.max(1, Math.min(8, Math.floor(batchSize))) }),
      setFrames: (frames) => set({ frames: Math.max(1, Math.min(120, Math.floor(frames))) }),
      setFps: (fps) => set({ fps: Math.max(1, Math.min(60, Math.floor(fps))) }),
      setDenoise: (denoise) => set({ denoise: Math.max(0, Math.min(1, denoise)) }),
      setI2iImage: (image) => set({ i2iImage: image }),
      setI2vImage: (image) => set({ i2vImage: image }),

      // ── redesign additions ──
      intent: () => deriveIntent(get()),
      setIntent: (intent) => set((s) => {
        // Clear intent-incompatible inputs: intents without a source drop both;
        // removebg/animate keep the source but drop a stale mask. Video/animate
        // mirror setMode's reset so image resolution never leaks into video.
        // A stale error from the previous intent never carries over.
        const dropAll = { source: null, mask: null, sourceSetAt: 0 }
        const base = { removebg: false, utilityOp: null, error: null }
        switch (intent) {
          case 'image':    return { ...base, mode: 'image' as const, imageSubMode: 'text2img' as const, ...dropAll }
          case 'edit':     return { ...base, mode: 'image' as const, imageSubMode: 'img2img' as const }
          case 'removebg': return { ...base, removebg: true, mode: 'image' as const, imageSubMode: 'img2img' as const, mask: null }
          // Cloud-only utility endpoints: upscale keeps the source (no mask,
          // no prompt); eraser keeps source + mask (paint what to remove).
          case 'upscale':  return { ...base, utilityOp: 'upscale' as const, mode: 'image' as const, imageSubMode: 'img2img' as const, mask: null }
          case 'eraser':   return { ...base, utilityOp: 'eraser' as const, mode: 'image' as const, imageSubMode: 'img2img' as const }
          case 'video': {
            const d = MODEL_TYPE_DEFAULTS[classifyModel(s.videoModel)] || MODEL_TYPE_DEFAULTS.unknown
            return { ...base, mode: 'video' as const, videoSubMode: 't2v' as const, ...dropAll,
              steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler,
              width: d.width, height: d.height, ...(d.frames ? { frames: d.frames } : {}), ...(d.fps ? { fps: d.fps } : {}) }
          }
          case 'animate': {
            const d = MODEL_TYPE_DEFAULTS[classifyModel(s.videoModel)] || MODEL_TYPE_DEFAULTS.unknown
            return { ...base, mode: 'video' as const, videoSubMode: 'i2v' as const, mask: null,
              steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler,
              width: d.width, height: d.height, ...(d.frames ? { frames: d.frames } : {}), ...(d.fps ? { fps: d.fps } : {}) }
          }
        }
      }),
      toggleNegative: () => set((s) => ({ showNegative: !s.showNegative })),
      toggleLora: (name) => set((s) => ({ selectedLoras: s.selectedLoras.some((l) => l.name === name) ? s.selectedLoras.filter((l) => l.name !== name) : [...s.selectedLoras, { name, strength: 0.8 }] })),
      setLoraStrengthFor: (name, strength) => set((s) => ({ selectedLoras: s.selectedLoras.map((l) => l.name === name ? { ...l, strength: Math.max(0, Math.min(2, strength)) } : l) })),
      clearLoras: () => set({ selectedLoras: [] }),
      setSelectedVae: (name) => set({ selectedVae: name || 'auto' }),
      setClipSkip: (n) => set({ clipSkip: Math.max(0, Math.min(12, Math.floor(n))) }),
      setGrowMaskBy: (n) => set({ growMaskBy: Math.max(0, Math.min(64, Math.floor(n))) }),
      setTargetResolution: (targetResolution) => set({ targetResolution }),
      setSource: (source) => set({ source, sourceSetAt: source ? Date.now() : 0, ...(source ? {} : { mask: null }) }),
      setMask: (mask) => set({ mask }),
      // Flipping to local clears every cloud-only intent (edit/animate/
      // upscale/eraser have no local lane — David 2026-07-10: advanced ops are
      // cloud-only; only removebg keeps a local lane via the RMBG node) so the
      // surface never strands on a dead op the IntentBar no longer shows.
      setBackend: (backend) =>
        set((s) => {
          if (backend !== 'local') return { backend }
          const patch: Record<string, unknown> = { backend }
          if (s.utilityOp) Object.assign(patch, { utilityOp: null, mask: null, error: null })
          if (s.imageSubMode === 'img2img' && !s.removebg) {
            Object.assign(patch, { imageSubMode: 'text2img', source: null, mask: null, sourceSetAt: 0, error: null })
          }
          if (s.videoSubMode === 'i2v') {
            Object.assign(patch, { videoSubMode: 't2v', source: null, mask: null, sourceSetAt: 0, error: null })
          }
          return patch
        }),
      setCloudImageModel: (cloudImageModel) => set({ cloudImageModel }),
      setCloudVideoModel: (cloudVideoModel) => set({ cloudVideoModel }),
      setCaps: (caps) => set({ caps }),
      resetParamsToModelDefaults: () => {
        const s = get()
        const d = s.mode === 'video'
          ? (MODEL_TYPE_DEFAULTS[classifyModel(s.videoModel)] || MODEL_TYPE_DEFAULTS.unknown)
          : MODEL_TYPE_DEFAULTS[s.imageModelType]
        set({ sampler: d.sampler, scheduler: d.scheduler, steps: d.steps, cfgScale: d.cfgScale, width: d.width, height: d.height, ...(d.frames ? { frames: d.frames } : {}), ...(d.fps ? { fps: d.fps } : {}) })
      },

      setIsGenerating: (generating) => set({ isGenerating: generating, ...(generating ? {} : { progressPhase: 'idle' as ProgressPhase }) }),
      setProgress: (progress, text) => set({ progress, progressText: text ?? '' }),
      setProgressPhase: (phase) => set({ progressPhase: phase }),
      setCurrentPromptId: (id) => set({ currentPromptId: id }),
      setVhsInstallPrompt: (resolver) => set({ vhsInstallPrompt: resolver }),
      setError: (error) => set({ error }),
      setLastGenTime: (time) => set({ lastGenTime: time }),
      addToGallery: (item) => set((s) => ({ gallery: [item, ...s.gallery].slice(0, 200) })),
      updateGalleryItem: (id, patch) =>
        set((s) => ({ gallery: s.gallery.map((g) => (g.id === id ? { ...g, ...patch } : g)) })),
      removeFromGallery: (id) => set((s) => ({ gallery: s.gallery.filter((g) => g.id !== id) })),
      clearGallery: () => set({ gallery: [] }),
      addToPromptHistory: (prompt) => set((s) => {
        const filtered = s.promptHistory.filter(p => p !== prompt)
        return { promptHistory: [prompt, ...filtered].slice(0, 50) }
      }),
      setImageModelList: (list) => set({ imageModelList: list }),
      setVideoModelList: (list) => set({ videoModelList: list }),
      setComfyRunning: (running) => set({ comfyRunning: running }),
    }),
    {
      name: 'create-store',
      partialize: (state) => ({
        mode: state.mode,
        videoBackend: state.videoBackend,
        videoBackendInitialized: state.videoBackendInitialized,
        imageModel: state.imageModel,
        imageModelType: state.imageModelType,
        videoModel: state.videoModel,
        sampler: state.sampler,
        scheduler: state.scheduler,
        steps: state.steps,
        cfgScale: state.cfgScale,
        width: state.width,
        height: state.height,
        batchSize: state.batchSize,
        frames: state.frames,
        fps: state.fps,
        denoise: state.denoise,
        // Media bytes never go to localStorage — a handful of multi-MB base64
        // dataUrls would blow the origin quota (~5-10 MB in WebView2/WKWebView)
        // and every subsequent set() would throw, killing ALL create-store
        // persistence. Cloud items carry remoteUrl + jobId and re-sign lazily.
        gallery: state.gallery.map(({ dataUrl, unavailable, ...g }: GalleryItem) => g),
        promptHistory: state.promptHistory,
        // ── redesign additions (advanced params only; runtime inputs
        //    source/mask/backend/caps stay unpersisted). No version bump: these
        //    are additive and merge() backfills missing keys from defaults. ──
        showNegative: state.showNegative,
        selectedLoras: state.selectedLoras,
        selectedVae: state.selectedVae,
        clipSkip: state.clipSkip,
        growMaskBy: state.growMaskBy,
      }),
      // Future schema bumps hook into migrate. NOTE: zustand only invokes it
      // when the stored blob carries a NUMERIC version that differs — legacy
      // pre-version blobs skip it entirely, so their fixups must live in merge.
      version: 1,
      migrate: (persisted: any) => persisted,
      merge: (persisted: any, current: any) => {
        // Never let runtime-only fields rehydrate (a foreign/corrupt blob must
        // not flip the backend axis or inject a stale source/mask), backfill
        // missing keys from defaults, and fix up legacy pre-version blobs
        // ('i2i' mode from the v2.3.0 refactor).
        const { backend, source, mask, caps, isGenerating, ...safe } =
          persisted ?? {}
        const merged = { ...current, ...safe }
        if (merged.mode === 'i2i') {
          merged.mode = 'image'
          merged.imageSubMode = 'img2img'
        }
        return merged
      },
    }
  )
)
