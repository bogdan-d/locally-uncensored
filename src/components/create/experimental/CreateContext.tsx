import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { useCreate } from '../../../hooks/useCreate'
import { useCreateStore } from '../../../stores/createStore'
import { useUIStore } from '../../../stores/uiStore'
import { getLoraModels, getVAEModels } from '../../../api/comfyui'
import { getAllNodeInfo } from '../../../api/comfyui-nodes'
import { ensureLocalFilename } from './loadImage'
import type { CloudQuota } from '../../../lib/render/cloud-jobs'

/**
 * The seam between the redesigned Create surface and the live backend. Replaces
 * the sandbox mockStore's non-persisted actions (generate/cancel) and mockComfy
 * (uploadImage/installCapability/capability lists). Everything else the ported
 * components need is read straight from useCreateStore.
 */
interface CreateExpValue {
  generate: () => void | Promise<void>
  cancel: () => void | Promise<void>
  /** ComfyUI /object_info sampler + scheduler names (fallback lists until loaded). */
  samplerList: string[]
  schedulerList: string[]
  /** Installed LoRA + VAE filenames for the Advanced drawer. */
  loraList: string[]
  vaeList: string[]
  connected: boolean | null
  modelsLoaded: boolean
  modelLoadError: string | null
  /** Route a missing capability (e.g. background-removal nodes) to the Model Manager. */
  installCapability: (cap: 'rmbg') => void
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
  // Desktop build: no hosted rendering — the cloud axis is permanently off.
  const cloudAvailable = false
  const quota: CloudQuota | null = null
  const refreshQuota = useCallback(async () => {}, [])
  const backend = useCreateStore((s) => s.backend)
  const setBackend = useCreateStore((s) => s.setBackend)
  const setView = useUIStore((s) => s.setView)
  const setCaps = useCreateStore((s) => s.setCaps)
  const [loraList, setLoraList] = useState<string[]>([])
  const [vaeList, setVaeList] = useState<string[]>(['auto'])

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
        })
      } catch { /* node probe is best-effort */ }
    })()
    return () => { cancelled = true }
  }, [connected, setCaps])

  const installCapability = useCallback((_cap: 'rmbg') => { setView('models') }, [setView])

  const value: CreateExpValue = {
    generate,
    cancel,
    samplerList, schedulerList, loraList, vaeList,
    connected, modelsLoaded, modelLoadError, installCapability,
    cloudAvailable, quota, refreshQuota,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
