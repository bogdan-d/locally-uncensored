import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { useCreate } from '../../../hooks/useCreate'
import { useCloudCreate, hasActiveCloudRun } from '../../../hooks/useCloudCreate'
import { useCloudSession } from '../../../hooks/useCloudSession'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { getLoraModels, getVAEModels, checkComfyConnection, refreshComfyModels } from '../../../api/comfyui'
import { getAllNodeInfo, clearNodeCache } from '../../../api/comfyui-nodes'
import { installCustomNodes, getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, startModelDownload, getDownloadProgress } from '../../../api/discover'
import { backendCall } from '../../../api/backend'
import { ensureLocalFilename } from './loadImage'
import type { CloudQuota } from '../../../lib/render/cloud-jobs'

/** Restart ComfyUI so a freshly installed node pack registers (packs only load
 *  on startup). stop_comfyui can only kill the ComfyUI that LU itself spawned:
 *  if the engine was started outside LU (user's own terminal/script), the old
 *  process keeps the port and keeps serving the stale node list — the pack
 *  would look installed but never show up, and the register-poll would burn
 *  40s to end in a misleading error. Detect that case and state the real fix. */
async function restartComfyForNewNodes(): Promise<void> {
  try { await backendCall('stop_comfyui') } catch { /* may already be stopped */ }
  // stop_comfyui reaps its child before returning, so LU's own engine is down
  // by now — poll a few extra rounds anyway instead of trusting one sleep.
  // Whatever still answers after that is an engine LU does not own.
  let stillUp = await checkComfyConnection()
  for (let i = 0; stillUp && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    stillUp = await checkComfyConnection()
  }
  if (stillUp) {
    throw new Error(
      'Your ComfyUI is running outside LU, so LU cannot restart it. New node packs only load on startup: restart your ComfyUI yourself, then come back here.',
    )
  }
  await backendCall('start_comfyui')
}

/**
 * The seam between the redesigned Create surface and the live backend. Replaces
 * the sandbox mockStore's non-persisted actions (generate/cancel) and mockComfy
 * (uploadImage/installCapability/capability lists). Everything else the ported
 * components need is read straight from useCreateStore.
 */
interface CreateExpValue {
  generate: () => void | Promise<void>
  cancel: () => void | Promise<void>
  /** Video super-resolution on a finished cloud render (Lightbox "Enhance"). */
  enhanceVideo: (item: GalleryItem, targetResolution?: '720p' | '1080p') => Promise<void>
  /** Talking-character voice maker (qwen3-tts) — lands an audio gallery item
   *  and pre-selects it as the lipsync voice. Cloud-only. */
  makeVoice: (opts: {
    text: string
    mode: 'speak' | 'design'
    voice?: string
    description?: string
  }) => Promise<void>
  /** ComfyUI /object_info sampler + scheduler names (fallback lists until loaded). */
  samplerList: string[]
  schedulerList: string[]
  /** Installed LoRA + VAE filenames for the Advanced drawer. */
  loraList: string[]
  vaeList: string[]
  connected: boolean | null
  modelsLoaded: boolean
  modelLoadError: string | null
  /** True while the ComfyUI that LU launched runs with --cpu (shd_scorpion,
   *  RX 7900 XTX): surfaces the honest slow-mode warning instead of a silent
   *  20-minute timeout. */
  comfyOnCpu: boolean
  /** Install a missing capability in place: ensure ComfyUI runs (installing it
   *  first if needed), download the custom node when one is required, restart,
   *  and re-probe until available. Reports progress via the optional callback
   *  and throws on failure. 'rmbg' = the RMBG cutout node; 'inpaint-nodes' =
   *  ComfyUI's core inpaint nodes (nothing to clone — present on any current
   *  install once ComfyUI is up). */
  installCapability: (cap: 'rmbg' | 'inpaint-nodes' | 'dwpose', onProgress?: (msg: string) => void) => Promise<void>
  /** One-click "everything you need" for a fresh PC: ensure ComfyUI runs
   *  (installing it first if needed), then download the default starter
   *  bundle for the intent kind (image → SDXL checkpoint, video → Wan 2.1,
   *  2.5.8 lanes → ACE / S2V / VACE starters incl. their node packs)
   *  with streamed progress, refresh ComfyUI's model enums and re-fetch the
   *  model lists. Throws on failure. */
  installModelBundle: (kind: 'image' | 'video' | 'audio' | 'lipsync' | 'motion', onProgress?: (msg: string) => void) => Promise<void>
  /** Runtime backend axis: hosted rendering offered for this session? */
  cloudAvailable: boolean
  quota: CloudQuota | null
  refreshQuota: () => Promise<void>
}

const Ctx = createContext<CreateExpValue | null>(null)

export function useCreateExp(): CreateExpValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useCreateExp must be used within <CreateExpProvider>')
  return v
}

export function CreateExpProvider({ children }: { children: ReactNode }) {
  const {
    generate, cancel, samplerList, schedulerList,
    connected, modelsLoaded, modelLoadError, checkConnection, fetchModels,
  } = useCreate()
  const { cloudAvailable, quota, refreshQuota } = useCloudSession()
  const cloud = useCloudCreate({ onQuotaChange: refreshQuota })
  const backend = useCreateStore((s) => s.backend)
  const setBackend = useCreateStore((s) => s.setBackend)
  const setCaps = useCreateStore((s) => s.setCaps)
  const [loraList, setLoraList] = useState<string[]>([])
  const [vaeList, setVaeList] = useState<string[]>(['auto'])
  const [comfyOnCpu, setComfyOnCpu] = useState(false)

  // Never strand the session on a dead axis: losing the license/logging out
  // while 'cloud' is selected falls back to local rendering.
  useEffect(() => {
    if (!cloudAvailable && backend === 'cloud') setBackend('local')
  }, [cloudAvailable, backend, setBackend])

  // Inputs picked while on cloud skip the ComfyUI staging (filename '') —
  // backfill it when the user switches to local so edit/animate keep working.
  useEffect(() => {
    if (backend !== 'local' || connected !== true) return
    const s = useCreateStore.getState()
    if (s.source && !s.source.filename) {
      ensureLocalFilename(s.source, 'source.png')
        .then((ref) => useCreateStore.getState().setSource(ref))
        .catch(() => { /* next generate surfaces the error */ })
    }
    if (s.mask && !s.mask.filename) {
      ensureLocalFilename(s.mask, 'mask.png')
        .then((ref) => useCreateStore.getState().setMask(ref))
        .catch(() => { /* next generate surfaces the error */ })
    }
  }, [backend, connected])

  // Bootstrap the backend exactly like the old CreateView mount did.
  useEffect(() => {
    checkConnection()
    fetchModels()
  }, [checkConnection, fetchModels])

  // Surface a CPU-only ComfyUI (no usable GPU detected) so an AMD / non-NVIDIA
  // user isn't left staring at a silent 20-minute timeout. The Rust side records
  // the launch mode at every ComfyUI (re)start; re-read it whenever the
  // connection (re)establishes. Desktop-only (web has no such command → false).
  useEffect(() => {
    if (connected !== true) { setComfyOnCpu(false); return }
    let cancelled = false
    backendCall<{ startedCpu?: boolean | null }>('get_comfy_gpu_status')
      .then((s) => { if (!cancelled) setComfyOnCpu(s?.startedCpu === true) })
      .catch(() => { if (!cancelled) setComfyOnCpu(false) })
    return () => { cancelled = true }
  }, [connected])

  // Once ComfyUI is reachable, fetch LoRA/VAE lists and probe installed
  // capabilities (RMBG for cutout, inpaint nodes) so the UI gates correctly.
  useEffect(() => {
    if (connected !== true) return
    let cancelled = false
    ;(async () => {
      const [loras, vaes] = await Promise.all([
        getLoraModels().catch(() => [] as string[]),
        getVAEModels().catch(() => [] as string[]),
      ])
      if (cancelled) return
      setLoraList(loras)
      setVaeList(['auto', ...vaes])
      try {
        const nodes = await getAllNodeInfo()
        if (cancelled) return
        const names = new Set(Object.keys(nodes))
        setCaps({
          rmbg: names.has('RMBG'),
          'inpaint-nodes': names.has('VAEEncodeForInpaint') || names.has('InpaintModelConditioning'),
          dwpose: names.has('DWPreprocessor'),
        })
      } catch { /* node probe is best-effort */ }
    })()
    return () => { cancelled = true }
  }, [connected, setCaps])

  // One-click prerequisite: make sure a local ComfyUI is actually running —
  // start it if it's merely stopped, INSTALL it first if it's missing (the
  // "complete noob PC" case: every Create tab's Download & install button must
  // deliver a 100% functional run, not assume ComfyUI exists).
  const ensureComfyRunning = useCallback(async (onProgress?: (msg: string) => void) => {
    if (await checkComfyConnection()) return
    onProgress?.('Starting ComfyUI…')
    try { await backendCall('start_comfyui') } catch { /* not installed yet — handled below */ }
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      if (await checkComfyConnection()) { checkConnection(); return }
    }
    onProgress?.('ComfyUI is not installed — downloading & installing it now (one-time, a few GB)…')
    await backendCall('install_comfyui')
    // Poll the same status contract the Settings installer uses. Generous cap:
    // a slow connection legitimately needs a while for the one-time install.
    for (let i = 0; i < 2700; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const st = await backendCall<{ status?: string; logs?: string[] }>('install_comfyui_status').catch(() => null)
      const lastLog = st?.logs?.length ? String(st.logs[st.logs.length - 1]) : ''
      if (lastLog) onProgress?.(lastLog)
      if (st?.status === 'complete') break
      if (st?.status === 'error') {
        throw new Error(lastLog || 'ComfyUI install failed — see Settings → AI Backends for details.')
      }
    }
    onProgress?.('Starting ComfyUI…')
    await backendCall('start_comfyui')
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      if (await checkComfyConnection()) { checkConnection(); return }
    }
    throw new Error('Installed ComfyUI but it did not come up — check Settings → AI Backends.')
  }, [checkConnection])

  // Install a capability in place — mirrors the VHS one-click flow (#72):
  // ensure ComfyUI runs, clone the custom node + pip install where one is
  // needed, restart ComfyUI so it registers, then poll /object_info (clearing
  // the node cache each round so we don't read the stale pre-install
  // catalogue) until the node shows up. The BiRefNet / RMBG-2.0 cutout model
  // is fetched by the node itself on the first run.
  const installCapability = useCallback(async (cap: 'rmbg' | 'inpaint-nodes' | 'dwpose', onProgress?: (msg: string) => void) => {
    await ensureComfyRunning(onProgress)
    const capsFrom = (names: Set<string>) => ({
      rmbg: names.has('RMBG'),
      'inpaint-nodes': names.has('VAEEncodeForInpaint') || names.has('InpaintModelConditioning'),
      dwpose: names.has('DWPreprocessor'),
    })
    if (cap === 'inpaint-nodes') {
      // Core ComfyUI nodes — nothing to clone. If they're still missing after
      // ComfyUI is up, the install is ancient; re-probe and say so honestly.
      const nodes = await getAllNodeInfo()
      const names = new Set(Object.keys(nodes))
      setCaps(capsFrom(names))
      if (!names.has('VAEEncodeForInpaint') && !names.has('InpaintModelConditioning')) {
        throw new Error(
          'This ComfyUI is missing its core inpaint nodes (VAEEncodeForInpaint) — update ComfyUI to a current version.',
        )
      }
      return
    }
    // Clone-and-pip capabilities share one flow: install the pack, restart
    // ComfyUI, poll /object_info (cache-cleared) until the node registers.
    const pack = cap === 'dwpose' ? 'controlnet-aux' : 'rmbg'
    const nodeClass = cap === 'dwpose' ? 'DWPreprocessor' : 'RMBG'
    onProgress?.(cap === 'dwpose'
      ? 'Downloading & installing the pose extractor (controlnet aux). This can take a minute…'
      : 'Downloading & installing the background removal node. This can take a minute…')
    await installCustomNodes([pack])
    onProgress?.('Restarting ComfyUI to register the node…')
    await restartComfyForNewNodes()
    onProgress?.('Waiting for ComfyUI to come back…')
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        clearNodeCache()
        const nodes = await getAllNodeInfo()
        const names = new Set(Object.keys(nodes))
        if (names.has(nodeClass)) {
          setCaps(capsFrom(names))
          return
        }
      } catch { /* ComfyUI still restarting — keep polling */ }
    }
    throw new Error(
      `Installed ${pack} and restarted ComfyUI, but it still isn't listing the ${nodeClass} node. ` +
      'Open the Model Manager to finish the install, or check the ComfyUI console for a pip error.',
    )
  }, [setCaps, ensureComfyRunning])

  // One-click starter models for a fresh PC: ensure ComfyUI, then pull the
  // default bundle for the intent kind (image → SDXL checkpoint, video →
  // Wan 2.1 files, 2.5.8 lanes → their own starter bundles) through the
  // existing resumable downloader, streaming percent progress into the card,
  // then refresh ComfyUI's model enums so the new files are pickable without
  // a restart. Bundles that need a custom node pack (GGUF loader, pose
  // extractor) install + register it first — one click really means one click.
  const installModelBundle = useCallback(async (kind: 'image' | 'video' | 'audio' | 'lipsync' | 'motion', onProgress?: (msg: string) => void) => {
    await ensureComfyRunning(onProgress)
    const bundle = (
      kind === 'image' ? getImageBundles()
      : kind === 'video' ? getVideoBundles()
      : kind === 'audio' ? getAudioBundles()
      : kind === 'lipsync' ? getLipsyncBundles()
      : getMotionBundles()
    )[0]
    if (!bundle) throw new Error('No starter bundle available for this intent.')
    if (bundle.customNodes?.length) {
      onProgress?.('Installing the required node packs…')
      await installCustomNodes(bundle.customNodes)
      onProgress?.('Restarting ComfyUI to register the new nodes…')
      await restartComfyForNewNodes()
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        if (await checkComfyConnection()) break
      }
      clearNodeCache()
    }
    for (const file of bundle.files) {
      if (!file.downloadUrl || !file.filename || !file.subfolder) continue
      const size = file.sizeGB ? ` (${file.sizeGB} GB)` : ''
      onProgress?.(`Downloading ${file.filename}${size}…`)
      const expected = file.sizeGB ? Math.round(file.sizeGB * 1_073_741_824) : undefined
      const start = await startModelDownload(file.downloadUrl, file.subfolder, file.filename, expected)
      if (start.status === 'error') throw new Error(start.error || `Could not start the ${file.filename} download.`)
      // 'exists' = already complete on disk — skip polling.
      if (start.status !== 'exists') {
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500))
          const all = await getDownloadProgress()
          const p = Object.values(all).find((d) => d.filename === file.filename)
          if (!p || p.status === 'complete') break
          if (p.status === 'error') throw new Error(p.error || `Download failed: ${file.filename}`)
          if (p.total > 0) {
            onProgress?.(`Downloading ${file.filename} — ${Math.round((p.progress / p.total) * 100)}%`)
          }
        }
      }
    }
    onProgress?.('Refreshing the model list…')
    await refreshComfyModels().catch(() => false)
    clearNodeCache()
    await fetchModels()
  }, [ensureComfyRunning, fetchModels])

  const value: CreateExpValue = {
    generate: backend === 'cloud' ? cloud.generate : generate,
    // Cancel routes by the backend that STARTED the run, not the current axis:
    // the header switch (or the license probe) can flip local/cloud mid-render,
    // and routing by the live value would abort a null handle while the real
    // run keeps going (a cloud job keeps billing; a local job keeps rendering).
    cancel: () => (hasActiveCloudRun() ? cloud.cancel() : cancel()),
    enhanceVideo: cloud.enhanceVideo,
    makeVoice: cloud.makeVoice,
    samplerList, schedulerList, loraList, vaeList,
    connected, modelsLoaded, modelLoadError, comfyOnCpu, installCapability, installModelBundle,
    cloudAvailable, quota, refreshQuota,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
