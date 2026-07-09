import { useCallback, useEffect, useMemo } from 'react'
import { listModels, pullModel as pullModelApi, pullModelTauri, deleteModel as deleteModelApi } from '../api/ollama'
import { isTauri } from '../api/backend'
import { getCheckpoints as getComfyCheckpoints, getDiffusionModels as getComfyDiffusionModels, checkComfyConnection, filterPartialFiles } from '../api/comfyui'
import { parseNDJSONStream } from '../api/stream'
import { useModelStore } from '../stores/modelStore'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getEnabledProviders, prefixModelName, getProviderIdFromModel } from '../api/providers'
import { listBundledModels, bundledToAIModels, activateBuiltinModel, isManagedBuiltinActive } from '../api/engine'
import type { PullProgress, AIModel, ModelCategory, ImageModel, VideoModel, CloudModel } from '../types/models'

const VIDEO_PATTERNS = [/wan/, /svd/, /animatediff/, /animate/, /video/, /cogvideo/, /ltx/i, /framepack/, /mochi/, /cosmos/, /hunyuan/, /pyramidflow/, /allegro/]

// Embedding models that should never appear in the chat model dropdown
const EMBEDDING_PATTERNS = [/embed/, /nomic-embed/, /bge-/, /e5-/, /gte-/, /sentence-/]

function isVideoModel(name: string): boolean {
  const lower = name.toLowerCase()
  return VIDEO_PATTERNS.some((p) => p.test(lower))
}

function isEmbeddingModel(name: string): boolean {
  const lower = name.toLowerCase()
  return EMBEDDING_PATTERNS.some((p) => p.test(lower))
}

export function useModels() {
  const {
    models: allModels, activeModel, activePulls, categoryFilter,
    setModels, setActiveModel, startPull, updatePullProgress,
    pausePull, completePull, dismissPull, setCategoryFilter,
  } = useModelStore()

  // Global Local/Cloud switch: one choke point for every picker — cloud mode
  // surfaces only the hosted catalog, local mode hides it. The store keeps
  // the full list (no refetch on flip); this is a view, not a mutation.
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const models = useMemo(
    () => allModels.filter((m) => (appMode === 'cloud' ? m.provider === 'lu-cloud' : m.provider !== 'lu-cloud')),
    [allModels, appMode],
  )

  const isPulling = Object.keys(activePulls).length > 0

  // Refresh trigger: any code path that just installed a model (onboarding,
  // DiscoverModels, the Ollama in-app installer) dispatches this event so
  // every mounted consumer of useModels re-fetches without needing a manual
  // RefreshCw click.
  useEffect(() => {
    const handler = () => { fetchModels().catch(() => {}) }
    window.addEventListener('lu-models-refresh', handler)
    // A finished ComfyUI image/video download fires 'comfyui-model-downloaded' —
    // from the download-store poller on completion AND from installBundleComplete
    // after it rescans ComfyUI. useModels must refetch on it too, or a freshly
    // downloaded model stays missing from the Installed tab + the chat/create
    // pickers until a manual reload (d37d7bf5 + neejuh, 2026-06-24, v2.5.5).
    // 'lu-models-refresh' alone did NOT cover this: installBundleComplete can bail
    // before any dispatch when ComfyUI is not fully up, while the file still
    // downloads and only the poller's event fires (verified live 2026-06-25).
    window.addEventListener('comfyui-model-downloaded', handler)
    return () => {
      window.removeEventListener('lu-models-refresh', handler)
      window.removeEventListener('comfyui-model-downloaded', handler)
    }
    // fetchModels is reassigned below on every render but always wraps the
    // same setModels — depending on it would just churn listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchModels = useCallback(async () => {
    try {
      const allModels: AIModel[] = []
      // Built-in engine (2.5.7): when the managed OpenAI-compat backend is the
      // active provider, its model list is the downloaded GGUFs (via the Tauri
      // `list_bundled_models` command), NOT `/v1/models` (which reports only the
      // single loaded model). Skip the openai client's listModels for it.
      const managedBuiltin = isManagedBuiltinActive()
      const providers = getEnabledProviders().filter(
        (p) => !(managedBuiltin && p.id === 'openai'),
      )
      const providerResults = await Promise.allSettled(
        providers.map(async (provider) => {
          const providerModels = await provider.listModels()
          return providerModels.map((pm): AIModel => {
            if (pm.provider === 'ollama') {
              return {
                name: pm.id, model: pm.id, size: 0, digest: '', modified_at: '',
                details: { parent_model: '', format: '', family: '', families: [], parameter_size: '', quantization_level: '' },
                type: 'text' as const, provider: 'ollama', providerName: 'Ollama',
              }
            }
            const prefixedName = prefixModelName(pm.provider, pm.id)
            return {
              name: prefixedName, model: pm.id, size: 0, type: 'text' as const,
              provider: pm.provider, providerName: pm.providerName,
              contextLength: pm.contextLength, supportsTools: pm.supportsTools, supportsVision: pm.supportsVision,
              thinkMode: pm.thinkMode,
              // Friendly server label (LU Cloud) — pickers prefer it over the id.
              displayName: pm.name !== pm.id ? pm.name : undefined,
            } satisfies CloudModel
          })
        })
      )
      for (const result of providerResults) {
        if (result.status === 'fulfilled') {
          // Filter out embedding models (e.g. nomic-embed-text) — not usable for chat
          allModels.push(...result.value.filter(m => !isEmbeddingModel(m.name)))
        }
      }
      // Built-in engine model list (downloaded GGUFs). Guarded: a missing/older
      // backend or non-Tauri dev context just yields no built-in models.
      if (managedBuiltin) {
        try {
          const bundled = bundledToAIModels(await listBundledModels())
          allModels.push(...bundled.filter(m => !isEmbeddingModel(m.name)))
        } catch { /* engine command unavailable — non-critical */ }
      }
      const ollamaEnabled = useProviderStore.getState().providers.ollama.enabled
      const hasOllamaModels = allModels.some(m => m.provider === 'ollama')
      if (ollamaEnabled && !hasOllamaModels) {
        try {
          const ollamaModels = await listModels()
          allModels.push(...ollamaModels
            .filter(m => !isEmbeddingModel(m.name))
            .map(m => ({ ...m, provider: 'ollama' as const, providerName: 'Ollama' })))
        } catch { /* Ollama might not be running */ }
      }
      let comfyModels: AIModel[] = []
      const comfyOk = await checkComfyConnection()
      if (comfyOk) {
        try {
          const [checkpoints, diffusionModels] = await Promise.all([getComfyCheckpoints(), getComfyDiffusionModels()])
          const allNames = [...checkpoints, ...diffusionModels]
          const complete = await filterPartialFiles(allNames)

          const classifyComfyModel = (name: string): AIModel => {
            if (isVideoModel(name)) return { name, model: name, size: 0, format: 'safetensors', architecture: 'unknown', type: 'video', providerName: 'ComfyUI' } as VideoModel
            return { name, model: name, size: 0, format: 'safetensors', architecture: 'unknown', type: 'image', providerName: 'ComfyUI' } as ImageModel
          }
          comfyModels = allNames.filter(name => complete.has(name)).map(classifyComfyModel)
        } catch { /* continue */ }
      }
      setModels([...allModels, ...comfyModels])
    } catch { /* ignore */ }
  }, [setModels])

  const pullModel = useCallback(
    async (name: string) => {
      const existing = activePulls[name]
      // If already active and not paused, don't restart
      if (existing && !existing.paused && !existing.complete) return

      const controller = new AbortController()
      startPull(name, controller)

      if (isTauri()) {
        const { promise, cancel } = pullModelTauri(name, (progress) => {
          updatePullProgress(name, progress)
        })
        controller.signal.addEventListener('abort', cancel)
        try {
          await promise
          completePull(name)
          try { await fetchModels() } catch { /* model list refresh failed — non-critical */ }
          // Auto-activate the freshly downloaded chat model so the chat actually
          // switches to it instead of silently staying on the old default
          // (forte_exe 2026-06-14: downloaded models didn't appear selected and
          // the chat kept reverting). Chat models only — image/video live in the
          // Create view. Matched by exact list name so a mismatch just no-ops.
          {
            const freshly = useModelStore.getState().models.find((m) => m.name === name)
            if (freshly && freshly.type !== 'image' && freshly.type !== 'video') setActiveModel(name)
          }
          // Auto-dismiss after 5s
          setTimeout(() => dismissPull(name), 5000)
        } catch (err) {
          // Bug Z/a v2.5.0 — leonsk29 GH #48. Pre-v2.5.0 this catch was
          // silent ("card stays visible"), which combined with the Rust-
          // side Ok(()) on stream-ended-without-success made LU flip the
          // badge to "Completed" even when Ollama returned a 400 or the
          // stream cut off after just the manifest. Now we surface the
          // real error string as the card's last status, so the user can
          // see *why* the pull failed (e.g. "Repo not GGUF compatible").
          // The cancellation case is still distinguished from real errors.
          const msg = (err as Error)?.message || String(err)
          if (!/cancelled/i.test(msg) && controller.signal.aborted !== true) {
            updatePullProgress(name, { status: `Failed: ${msg}` })
          }
        }
        return
      }

      // Dev mode: streaming fetch
      try {
        const response = await pullModelApi(name, controller.signal)
        let streamError: string | null = null
        for await (const chunk of parseNDJSONStream<PullProgress>(response)) {
          updatePullProgress(name, chunk)
          // Surface an error the NDJSON stream reports mid-pull instead of
          // falsely flipping the card to "complete" (adhney; mirrors the
          // Tauri-path Bug Z/a handling above).
          if (chunk.error) { streamError = chunk.error; break }
        }
        if (streamError) {
          updatePullProgress(name, { status: `Error: ${streamError}` })
        } else {
          completePull(name)
          try { await fetchModels() } catch { /* non-critical */ }
          // Auto-activate the freshly downloaded chat model (see note above).
          {
            const freshly = useModelStore.getState().models.find((m) => m.name === name)
            if (freshly && freshly.type !== 'image' && freshly.type !== 'video') setActiveModel(name)
          }
          setTimeout(() => dismissPull(name), 5000)
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          updatePullProgress(name, { status: `Error: ${(err as Error).message}` })
        }
        // On abort (pause): card stays with "Paused" status
      }
    },
    [activePulls, fetchModels, startPull, updatePullProgress, completePull, dismissPull, setActiveModel]
  )

  const isPullingModel = useCallback(
    (name: string) => {
      const pull = activePulls[name]
      return !!pull && !pull.paused && !pull.complete
    },
    [activePulls]
  )

  const removeModel = useCallback(
    async (name: string) => {
      await deleteModelApi(name)
      await fetchModels()
    },
    [fetchModels]
  )

  const getFilteredModels = (filter: ModelCategory = categoryFilter) => {
    if (filter === 'all') return models
    return models.filter((m: AIModel) => m.type === filter)
  }

  // Selecting a built-in model must also swap the loaded GGUF: the managed
  // engine serves one model per process, so activation → swap_bundled_model.
  // Other providers just set the active model as before.
  const activateModel = useCallback((name: string) => {
    setActiveModel(name)
    const cfg = useProviderStore.getState().providers.openai
    if (cfg.enabled && cfg.managed && getProviderIdFromModel(name) === 'openai') {
      void activateBuiltinModel(name).catch(() => { /* engine unavailable — non-critical */ })
    }
  }, [setActiveModel])

  return {
    models, activeModel, activePulls, isPulling, categoryFilter,
    fetchModels, pullModel, pausePull, dismissPull,
    removeModel, setActiveModel: activateModel, setCategoryFilter, getFilteredModels, isPullingModel,
  }
}
