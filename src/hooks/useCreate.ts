import { useState, useCallback, useRef, useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import {
  checkComfyConnection,
  refreshComfyModels,
  getImageModels,
  getVideoModels,
  getSamplers,
  getSchedulers,
  detectVideoBackend,
  cancelGeneration,
  submitWorkflow,
  getHistory,
  buildTxt2ImgWorkflow,
  buildTxt2VidWorkflow,
  classifyModel,
  extractComfyOutputFiles,
  type ClassifiedModel,
  type ComfyUIOutput,
  type VideoBackend,
} from '../api/comfyui'
import { comfyErrorHint } from '../api/vram-handoff'
import {
  comfyWS, CLIENT_ID,
  LOADER_NODES, CLIP_LOADER_NODES, VAE_LOADER_NODES, SAMPLER_NODES, DECODE_NODES,
  type ComfyWSEvent,
} from '../api/comfyui-ws'
import { buildDynamicWorkflow, checkVideoOutputCapability } from '../api/dynamic-workflow'
import { getAllNodeInfo, clearNodeCache } from '../api/comfyui-nodes'
import { installCustomNodes } from '../api/discover'
import { backendCall } from '../api/backend'
import { checkPromptSafety, SAFETY_BLOCK_MESSAGE } from '../lib/render/safety'
import { useCreateStore } from '../stores/createStore'
import { useWorkflowStore } from '../stores/workflowStore'
import { injectParameters } from '../api/workflows'
import { preflightCheck } from '../api/preflight'

export function useCreate() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [imageModels, setImageModels] = useState<ClassifiedModel[]>([])
  const [videoModelsList, setVideoModelsList] = useState<ClassifiedModel[]>([])
  const [samplerList, setSamplerList] = useState<string[]>([])
  const [schedulerList, setSchedulerList] = useState<string[]>([])
  const [videoBackend, setVideoBackend] = useState<VideoBackend>('none')
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [modelLoadError, setModelLoadError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const checkConnection = useCallback(async () => {
    const ok = await checkComfyConnection()
    setConnected(ok)
    // Mirror into createStore so the header-level Lichtschalter in
    // CreateTopControls stays in sync with the deeper useCreate state.
    useCreateStore.getState().setComfyRunning(ok)
    return ok
  }, [])

  const runPreflight = useCallback(async () => {
    const state = useCreateStore.getState()
    const activeModel = state.mode === 'image' ? state.imageModel : state.videoModel
    if (!activeModel) {
      state.setPreflightStatus(null, [], [])
      return
    }
    try {
      const result = await preflightCheck(activeModel, state.mode, state.width, state.height)
      state.setPreflightStatus(
        result.ready,
        result.errors,
        result.warnings.map(w => w.message),
      )
    } catch {
      state.setPreflightStatus(null, [], [])
    }
  }, [])

  const zeroModelRetries = useRef(0)

  const fetchModels = useCallback(async () => {
    setModelLoadError(null)

    try {
      // Check connection first — if ComfyUI is down, don't waste time on model queries
      const comfyOk = await checkComfyConnection()
      if (!comfyOk) {
        setModelLoadError('ComfyUI is not running. Start it from Settings or wait for auto-start.')
        return
      }

      // Force ComfyUI to re-scan model directories before querying.
      // This fixes the case where models were downloaded while ComfyUI was running
      // and its internal cache hasn't updated yet.
      await refreshComfyModels()

      const [comfyImgModels, vidModels, samplers, schedulers, vBackend, _nodeInfo] = await Promise.all([
        getImageModels(),
        getVideoModels(),
        getSamplers(),
        getSchedulers(),
        detectVideoBackend(),
        getAllNodeInfo().catch(() => null),
      ])
      const imgModels = comfyImgModels
      setImageModels(imgModels)
      setVideoModelsList(vidModels)
      setSamplerList(samplers)
      setSchedulerList(schedulers)
      setVideoBackend(vBackend)

      // Mirror the fetched lists into createStore so the header-level
      // CreateTopControls dropdown (which does NOT host its own useCreate)
      // can render without crashing on undefined. Discord-reported by
      // @diimmortalis (console: `activeList is undefined`).
      const st = useCreateStore.getState()
      st.setImageModelList(imgModels)
      st.setVideoModelList(vidModels)

      // If ComfyUI is connected but returns 0 models, do NOT set modelsLoaded — keep retrying.
      // ComfyUI may still be scanning directories (race condition on startup).
      if (imgModels.length === 0 && vidModels.length === 0) {
        zeroModelRetries.current++
        if (zeroModelRetries.current <= 12) {
          // Still retrying — ComfyUI might not be done scanning yet
          console.log(`[useCreate] 0 models found, retry ${zeroModelRetries.current}/12...`)
          setModelLoadError('ComfyUI is loading models... This can take a moment after startup.')
          // Don't set modelsLoaded — auto-retry will keep running
        } else {
          // Give up retrying — flip to loaded so the empty-state UI can render.
          // Clear any stale persisted model names so callers don't try to
          // generate against a model that no longer exists.
          const state = useCreateStore.getState()
          if (state.imageModel) {
            console.warn(`[useCreate] Clearing stale persisted imageModel "${state.imageModel}" (0 models installed).`)
            state.setImageModel('', 'unknown')
          }
          if (state.videoModel) {
            console.warn(`[useCreate] Clearing stale persisted videoModel "${state.videoModel}" (0 models installed).`)
            state.setVideoModel('')
          }
          setModelsLoaded(true)
          setModelLoadError(null)  // empty-state UI handles this — don't double-up
        }
        return
      }

      // Models found — reset retry counter and mark loaded
      zeroModelRetries.current = 0
      setModelsLoaded(true)

      const state = useCreateStore.getState()
      // Auto-select first models if none set (or stale name no longer exists)
      if (imgModels.length > 0) {
        if (!state.imageModel) {
          state.setImageModel(imgModels[0].name, imgModels[0].type)
        }
      } else if (state.imageModel) {
        // Image models absent but videos found — clear stale image model
        console.warn(`[useCreate] No image models installed, clearing stale imageModel "${state.imageModel}".`)
        state.setImageModel('', 'unknown')
      }
      if (vidModels.length > 0) {
        if (!state.videoModel || !vidModels.find(m => m.name === state.videoModel)) {
          if (state.videoModel) console.warn(`[useCreate] Persisted videoModel "${state.videoModel}" not found, resetting to ${vidModels[0].name}`)
          state.setVideoModel(vidModels[0].name)
        }
      } else if (state.videoModel) {
        // Video models absent but images found — clear stale video model
        console.warn(`[useCreate] No video models installed, clearing stale videoModel "${state.videoModel}".`)
        state.setVideoModel('')
      }
      // Always re-sync model type for currently selected model (fixes stale type after restart)
      if (state.imageModel && imgModels.length > 0) {
        const current = imgModels.find(m => m.name === state.imageModel)
        if (current) {
          if (current.type !== state.imageModelType) {
            console.log(`[useCreate] Fixing model type: ${state.imageModelType} -> ${current.type}`)
            state.setImageModel(state.imageModel, current.type)
          }
        } else {
          // Persisted model no longer exists in ComfyUI — reset to first available
          console.warn(`[useCreate] Persisted imageModel "${state.imageModel}" not found in ComfyUI, resetting to ${imgModels[0].name}`)
          state.setImageModel(imgModels[0].name, imgModels[0].type)
        }
      }
      // Run preflight check after models are loaded
      setTimeout(() => runPreflight(), 100)
    } catch (err) {
      console.error('[useCreate] Failed to fetch models:', err)
      setModelLoadError(`Failed to load models: ${err instanceof Error ? err.message : 'ComfyUI API error'}`)
    }
  }, [runPreflight])

  // Auto-refresh models when a ComfyUI model download completes.
  // Schedules three fetches because real-world ComfyUI scans take longer than
  // the /api/refresh round-trip implies: the API responds OK but the in-memory
  // model list catches up only after the directory walk finishes. A single
  // fetch immediately after the event was leaving Draekzy + cprovencher
  // staring at a "model installed but not in dropdown" state for minutes.
  useEffect(() => {
    let cancelled = false
    const timeouts: ReturnType<typeof setTimeout>[] = []
    const handler = () => {
      console.log('[useCreate] Model download completed, refreshing model list...')
      fetchModels()
      // Belt-and-braces: re-fetch at +2s and +6s in case ComfyUI's scan is slow.
      // fetchModels() is idempotent and cheap (object_info hits cache server-side),
      // so a couple of extra calls cost almost nothing.
      timeouts.push(setTimeout(() => { if (!cancelled) fetchModels() }, 2000))
      timeouts.push(setTimeout(() => { if (!cancelled) fetchModels() }, 6000))
    }
    window.addEventListener('comfyui-model-downloaded', handler)
    return () => {
      cancelled = true
      timeouts.forEach(clearTimeout)
      window.removeEventListener('comfyui-model-downloaded', handler)
    }
  }, [fetchModels])

  // Auto-retry model loading when ComfyUI reconnects OR when 0 models found (startup race)
  useEffect(() => {
    if (!modelLoadError) return  // No error — nothing to retry
    if (modelsLoaded) return     // modelsLoaded + error = gave up after max retries, don't loop
    const retryInterval = setInterval(async () => {
      const ok = await checkComfyConnection()
      if (ok) {
        console.log('[useCreate] Retrying model fetch...')
        fetchModels()
      }
    }, 3000)
    return () => clearInterval(retryInterval)
  }, [modelLoadError, modelsLoaded, fetchModels])

  const generateInner = useCallback(async () => {
    const state = useCreateStore.getState()
    // AI-CSAM gate — applies before any backend is touched.
    {
      const verdict = checkPromptSafety(`${state.prompt} ${state.negativePrompt}`)
      if (verdict.blocked) {
        state.setError(SAFETY_BLOCK_MESSAGE)
        return
      }
    }
    const {
      mode, prompt, negativePrompt, imageModel, videoModel,
      sampler, scheduler, steps, cfgScale, width, height, seed, batchSize, frames, fps, denoise, i2iImage, i2vImage,
      source, mask, growMaskBy, removebg, selectedLoras, selectedVae, clipSkip,
      setIsGenerating, setProgress, setCurrentPromptId, setError, addToGallery, addToPromptHistory,
    } = state

    const isI2I = mode === 'image' && state.imageSubMode === 'img2img'
    // Which redesign intent produced this run (gallery tag).
    const intent = state.intent()
    // The redesigned Create page drives its unified Stage input via `source`/`mask`
    // ImageRefs. On the local path their `.filename` IS the ComfyUI /upload/image
    // name, so they map straight onto the existing i2iImage/i2vImage handles.
    const effInputImage = source?.filename ?? i2iImage
    const effI2vImage = source?.filename ?? i2vImage
    const maskFilename = mask?.filename
    const isRemoveBg = mode === 'image' && removebg

    // Desktop port: the MLX video/image pipelines (Apple Silicon) are not
    // part of this build — ComfyUI is the only local backend.

    setError(null)
    const activeModel = mode === 'image' ? imageModel : videoModel
    // Always re-classify from model name to avoid stale type
    const imageModelType = classifyModel(activeModel)

    // Background removal is prompt-free and model-independent (RMBG node).
    if (!isRemoveBg && !prompt.trim()) {
      setError('Please enter a prompt.')
      return
    }
    if (isRemoveBg && !effInputImage) {
      setError('Please add an image to remove its background.')
      return
    }
    if (isI2I && !isRemoveBg && !effInputImage) {
      setError('Please add a source image first.')
      return
    }
    // Local Edit is mask inpaint — without a painted mask it would silently
    // degrade to plain img2img and repaint the WHOLE image.
    if (intent === 'edit' && !maskFilename) {
      setError('Paint a mask first — open the mask editor and mark the area to change.')
      return
    }
    if (!isRemoveBg && !activeModel) {
      setError(mode === 'image'
        ? 'No image model selected. Add checkpoints or FLUX models to ComfyUI.'
        : 'No video model selected. Install Wan 2.1 or AnimateDiff models.')
      return
    }

    const isRunning = await checkComfyConnection()
    if (!isRunning) {
      setError('ComfyUI is not running. Wait for it to start.')
      return
    }

    setIsGenerating(true)
    setProgress(0, 'Preparing workflow...')
    abortRef.current = new AbortController()

    try {
      const baseParams = {
        prompt, negativePrompt, model: activeModel, sampler, scheduler, steps, cfgScale, width, height, seed, batchSize,
        ...(isRemoveBg && effInputImage ? { removebg: true, inputImage: effInputImage } : {}),
        ...(isI2I && !isRemoveBg && effInputImage ? { inputImage: effInputImage, denoise } : {}),
        ...(!isRemoveBg && maskFilename ? { maskImage: maskFilename, growMaskBy } : {}),
        // Advanced adjustments. LoRA feeds the builder's `lora`/`loraStrength`
        // contract (string[] + number[]); the old `loras` key was read by nobody,
        // so LoRA selection was a silent no-op for image too (D#80). VAE/clip-skip
        // stay image-only (the builder ignores them for video).
        ...(selectedLoras.length
          ? { lora: selectedLoras.map((l) => l.name), loraStrength: selectedLoras.map((l) => l.strength) }
          : {}),
        ...(selectedVae && selectedVae !== 'auto' ? { vae: selectedVae } : {}),
        ...(clipSkip > 0 ? { clipSkip } : {}),
      }

      let workflow: Record<string, any>
      let builderUsed: 'dynamic' | 'legacy' | 'custom' = 'dynamic'

      // Check for custom workflow assignment — but verify it's compatible with the model
      let customWf = useWorkflowStore.getState().getWorkflowForModel(activeModel, imageModelType)
      if (customWf) {
        const wfNodes = Object.values(customWf.workflow).map((n: any) => n.class_type)
        const needsUnet = imageModelType === 'flux' || imageModelType === 'flux2' || imageModelType === 'zimage' || imageModelType === 'wan' || imageModelType === 'hunyuan'
        const hasUnet = wfNodes.includes('UNETLoader')
        const hasCheckpoint = wfNodes.includes('CheckpointLoaderSimple')
        if (needsUnet && !hasUnet && hasCheckpoint) {
          console.warn('[useCreate] Custom workflow incompatible: model needs UNETLoader but workflow has CheckpointLoaderSimple. Using auto.')
          customWf = null
        } else if (!needsUnet && hasUnet && !hasCheckpoint) {
          console.warn('[useCreate] Custom workflow incompatible: model needs CheckpointLoaderSimple but workflow has UNETLoader. Using auto.')
          customWf = null
        }
      }
      console.log('[useCreate] Custom workflow check:', { activeModel, imageModelType, found: customWf?.name ?? 'NONE (auto)' })

      if (customWf) {
        builderUsed = 'custom'
        setProgress(5, `Using workflow: ${customWf.name}...`)
        const params = mode === 'video' ? { ...baseParams, frames, fps, ...(effI2vImage ? { inputImage: effI2vImage } : {}) } : baseParams
        workflow = await injectParameters(customWf.workflow, customWf.parameterMap, params, imageModelType)
      } else {
        // Dynamic workflow builder — auto-detects nodes and builds the right pipeline
        setProgress(5, 'Building workflow...')
        try {
          const genParams = mode === 'video' ? { ...baseParams, frames, fps, ...(effI2vImage ? { inputImage: effI2vImage } : {}) } : baseParams
          workflow = await buildDynamicWorkflow(genParams, imageModelType)
          builderUsed = 'dynamic'
        } catch (dynErr) {
          // A WorkflowUnavailableError carries an actionable message ("download
          // <encoder> from the Model Manager") — surface it directly instead of
          // falling back to a legacy builder that would fail the same way with
          // a cryptic ComfyUI rejection.
          if (dynErr instanceof Error && dynErr.name === 'WorkflowUnavailableError') {
            throw dynErr
          }
          // Fallback to legacy builders if dynamic fails
          console.warn('[useCreate] Dynamic builder failed, using legacy:', dynErr)
          builderUsed = 'legacy'
          setProgress(5, 'Using legacy builder...')
          if (mode === 'video') {
            workflow = await buildTxt2VidWorkflow({ ...baseParams, frames, fps }, videoBackend)
          } else {
            workflow = await buildTxt2ImgWorkflow(baseParams, imageModelType)
          }
        }
        // Bug A (v2.4.5 — miguelkodoatie Discord 2026-05-14, Turbulent_Tomato7559
        // Reddit 2026-05-10): when ComfyUI lacks VHS_VideoCombine the video
        // workflow falls back to SaveAnimatedWEBP and produces an animated
        // .webp instead of an .mp4. v2.4.4 added a warning banner; v2.4.5
        // turns it into a blocking modal with a one-click install, so users
        // get actual videos instead of trying to figure out why "video gen"
        // gave them an image.
        if (mode === 'video' && builderUsed === 'dynamic') {
          try {
            const caps = await checkVideoOutputCapability()
            if (caps.webpOnly) {
              const choice = await new Promise<'install' | 'webp' | 'cancel'>((resolve) => {
                useCreateStore.getState().setVhsInstallPrompt(resolve)
              })
              useCreateStore.getState().setVhsInstallPrompt(null)

              if (choice === 'cancel') {
                setIsGenerating(false)
                setProgress(0, '')
                return
              }
              if (choice === 'install') {
                setProgress(8, 'Installing VHS_VideoCombine (git clone + pip)...')
                try {
                  await installCustomNodes(['videohelpersuite'])
                  setProgress(9, 'Restarting ComfyUI to register the new node...')
                  try {
                    await backendCall('stop_comfyui')
                  } catch { /* may already be stopped */ }
                  await new Promise(r => setTimeout(r, 2000))
                  await backendCall('start_comfyui')
                  // Wait for ComfyUI to come back; poll /object_info up to 30s
                  let backUp = false
                  for (let i = 0; i < 15; i++) {
                    await new Promise(r => setTimeout(r, 2000))
                    try {
                      const ok = await checkComfyConnection()
                      if (ok) { backUp = true; break }
                    } catch { /* not yet */ }
                  }
                  if (!backUp) {
                    setError('VHS_VideoCombine installed but ComfyUI did not come back online within 30s. Please restart ComfyUI manually and re-generate.')
                    setIsGenerating(false)
                    return
                  }
                  // #72 (bob): the node catalogue is cached for 5 minutes, so
                  // without a forced refresh the rebuild below still saw the
                  // pre-install catalogue (no VHS) and silently produced a
                  // .webp even after a successful install + restart.
                  clearNodeCache()
                  const capsAfter = await checkVideoOutputCapability()
                  if (!capsAfter.mp4Capable) {
                    setError(
                      'VHS_VideoCombine was installed and ComfyUI restarted, but ComfyUI still does not list the node. ' +
                      'Check the ComfyUI startup log for "IMPORT FAILED: ComfyUI-VideoHelperSuite" (usually a Python requirements problem), then generate again.'
                    )
                    setIsGenerating(false)
                    return
                  }
                  // Re-build the workflow now that the new node is available
                  const genParams = { ...baseParams, frames, fps, ...(effI2vImage ? { inputImage: effI2vImage } : {}) }
                  workflow = await buildDynamicWorkflow(genParams, imageModelType)
                  setProgress(10, 'VHS installed — generating MP4...')
                } catch (instErr) {
                  setError(`Failed to install VHS_VideoCombine: ${instErr instanceof Error ? instErr.message : String(instErr)}. You can install it manually in ComfyUI Manager.`)
                  setIsGenerating(false)
                  return
                }
              } else {
                // 'webp' — user opted to continue with the animated .webp
                setProgress(8, 'Continuing with animated .webp output (no VHS_VideoCombine)')
              }
            }
          } catch { /* non-fatal */ }
        }
      }

      setProgress(10, 'Submitting to ComfyUI...')
      let promptId: string
      try {
        promptId = await submitWorkflow(workflow, CLIENT_ID)
      } catch (err) {
        setError(`Failed to submit: ${err instanceof Error ? err.message : String(err)}`)
        setIsGenerating(false)
        return
      }
      setCurrentPromptId(promptId)
      addToPromptHistory(prompt)

      // Build node ID → class_type map from workflow for phase detection
      const nodeClassMap = new Map<string, string>()
      for (const [nodeId, node] of Object.entries(workflow)) {
        if (node && typeof node === 'object' && 'class_type' in node) {
          nodeClassMap.set(nodeId, (node as any).class_type)
        }
      }

      // Try WebSocket-driven progress, fall back to polling
      const maxTime = mode === 'video' ? 60 * 60 * 1000 : 20 * 60 * 1000
      let useWS = false
      try {
        await comfyWS.connect(3000)
        useWS = true
      } catch {
        console.warn('[useCreate] WebSocket unavailable, using polling fallback')
      }

      if (useWS) {
        // ── WebSocket-driven progress ──
        await new Promise<void>((resolve, reject) => {
          const startTime = Date.now()
          const store = useCreateStore.getState()
          store.setProgressPhase('queued')
          setProgress(10, 'Queued...')

          const timeoutTimer = setTimeout(() => {
            cleanup()
            reject(new Error(`Generation timed out after ${Math.round(maxTime / 60000)} minutes`))
          }, maxTime)

          // Heartbeat: check ComfyUI every 10s + poll for completion (catches missed WS events)
          let completionHandled = false
          const heartbeat = setInterval(async () => {
            if (completionHandled) return
            const alive = await checkComfyConnection()
            if (!alive) { cleanup(); reject(new Error('ComfyUI stopped responding during generation')); return }
            // Poll history to catch completion if WebSocket event was missed
            try {
              const history = await getHistory(promptId)
              if (!history) return
              const statusStr = history.status?.status_str
              if (statusStr === 'success') {
                completionHandled = true
                console.log('[useCreate] Completion detected via polling (WS event missed)')
                cleanup()
                useCreateStore.getState().setProgressPhase('complete')
                setProgress(95, 'Fetching results...')
                const messages: [string, any][] = history.status?.messages ?? []
                const startMsg = messages.find(([t]: [string, any]) => t === 'execution_start')
                const endMsg = messages.find(([t]: [string, any]) => t === 'execution_success')
                const comfyTime = startMsg?.[1]?.timestamp && endMsg?.[1]?.timestamp
                  ? ((endMsg[1].timestamp - startMsg[1].timestamp) / 1000).toFixed(1) : null
                setProgress(100, 'Complete!')
                useCreateStore.getState().setLastGenTime(comfyTime ? `${comfyTime}s` : null)
                const outputs = history.outputs ?? {}
                let found = false
                for (const nodeId of Object.keys(outputs)) {
                  // Extract files from ANY keyed array, not just images/gifs/
                  // videos — custom save nodes post under other keys (audio,
                  // result, files, …); previously those outputs were dropped
                  // even though they existed on disk.
                  const files: ComfyUIOutput[] = extractComfyOutputFiles(outputs[nodeId])
                  for (const file of files) {
                    found = true
                    addToGallery({
                      id: uuid(), type: mode,
                      filename: file.filename, subfolder: file.subfolder ?? '',
                      prompt, negativePrompt, model: activeModel,
                      modelType: mode === 'image' ? imageModelType : (videoModelsList.find(m => m.name === activeModel)?.type ?? 'wan'),
                      seed: seed === -1 ? 0 : seed,
                      steps, cfgScale, sampler, scheduler, width, height, batchSize,
                      createdAt: Date.now(), builderUsed, intent,
                    })
                  }
                }
                if (!found) setError('Generation completed but no output was produced.')
                resolve()
              } else if (statusStr === 'error') {
                completionHandled = true
                cleanup()
                const msgs = history.status?.messages ?? []
                const errEntry = msgs.find(([t]: [string, any]) => t === 'execution_error')?.[1]
                const raw = errEntry?.exception_message || 'ComfyUI execution error'
                const hint = comfyErrorHint(errEntry?.node_type, errEntry?.exception_type, String(raw))
                reject(new Error(hint ? `${raw}\n\n${hint}` : raw))
              }
            } catch { /* polling failure is non-fatal */ }
          }, 10000)

          let abortCheck: ReturnType<typeof setInterval> | null = null

          const cleanup = () => {
            clearTimeout(timeoutTimer)
            clearInterval(heartbeat)
            if (abortCheck) clearInterval(abortCheck)
            removeListener()
          }

          const removeListener = comfyWS.on((event: ComfyWSEvent) => {
            // Only handle events for our prompt
            if ('prompt_id' in event.data && event.data.prompt_id !== promptId) return

            const elapsed = Math.round((Date.now() - startTime) / 1000)
            const st = useCreateStore.getState()

            switch (event.type) {
              case 'executing': {
                const nodeId = event.data.node
                if (nodeId === null) {
                  // null node means execution finished for this prompt
                  break
                }
                const classType = nodeClassMap.get(nodeId) || ''
                if (LOADER_NODES.has(classType)) {
                  st.setProgressPhase('loading-model')
                  setProgress(15, `Loading model... ${elapsed}s`)
                } else if (CLIP_LOADER_NODES.has(classType)) {
                  st.setProgressPhase('loading-clip')
                  setProgress(25, `Loading text encoder... ${elapsed}s`)
                } else if (VAE_LOADER_NODES.has(classType)) {
                  st.setProgressPhase('loading-vae')
                  setProgress(30, `Loading VAE... ${elapsed}s`)
                } else if (SAMPLER_NODES.has(classType)) {
                  st.setProgressPhase('sampling')
                  setProgress(35, `Sampling... ${elapsed}s`)
                } else if (DECODE_NODES.has(classType)) {
                  st.setProgressPhase('decoding')
                  setProgress(90, `Decoding... ${elapsed}s`)
                }
                break
              }
              case 'progress': {
                const { value, max } = event.data
                const stepPct = 35 + (value / max) * 55 // 35% to 90%
                st.setProgressPhase('sampling')
                setProgress(Math.round(stepPct), `Sampling step ${value}/${max}... ${elapsed}s`)
                break
              }
              case 'execution_complete': {
                if (completionHandled) break
                completionHandled = true
                cleanup()
                st.setProgressPhase('complete')
                setProgress(95, 'Fetching results...')
                // Fetch history to get output files
                getHistory(promptId).then(history => {
                  if (!history) { setError('No history found after completion.'); resolve(); return }
                  const messages: [string, any][] = history.status?.messages ?? []
                  const startMsg = messages.find(([t]) => t === 'execution_start')
                  const endMsg = messages.find(([t]) => t === 'execution_success')
                  const comfyTime = startMsg?.[1]?.timestamp && endMsg?.[1]?.timestamp
                    ? ((endMsg[1].timestamp - startMsg[1].timestamp) / 1000).toFixed(1) : null
                  setProgress(100, 'Complete!')
                  useCreateStore.getState().setLastGenTime(comfyTime ? `${comfyTime}s` : null)
                  const outputs = history.outputs ?? {}
                  let found = false
                  for (const nodeId of Object.keys(outputs)) {
                    // Same generic extraction as the heartbeat branch above.
                    const files: ComfyUIOutput[] = extractComfyOutputFiles(outputs[nodeId])
                    for (const file of files) {
                      found = true
                      addToGallery({
                        id: uuid(), type: mode,
                        filename: file.filename, subfolder: file.subfolder ?? '',
                        prompt, negativePrompt, model: activeModel,
                        modelType: mode === 'image' ? imageModelType : (videoModelsList.find(m => m.name === activeModel)?.type ?? 'wan'),
                        seed: seed === -1 ? 0 : seed,
                        steps, cfgScale, sampler, scheduler, width, height, batchSize,
                        createdAt: Date.now(), builderUsed,
                      })
                    }
                  }
                  if (!found) setError('Generation completed but no output was produced. Check ComfyUI logs.')
                  resolve()
                }).catch(() => { resolve() })
                break
              }
              case 'execution_error': {
                cleanup()
                const msg = event.data.exception_message || 'Unknown ComfyUI error'
                const nodeType = event.data.node_type ? ` (${event.data.node_type})` : ''
                const hint = comfyErrorHint(event.data.node_type, (event.data as any).exception_type, msg)
                reject(new Error(msg.trim() + nodeType + (hint ? `\n\n${hint}` : '')))
                break
              }
            }
          })

          // Also check abort
          abortCheck = setInterval(() => {
            if (abortRef.current?.signal.aborted) {
              cleanup()
              reject(new Error('Cancelled'))
            }
          }, 500)
        })
      } else {
        // ── Polling fallback (original approach) ──
        await new Promise<void>((resolve, reject) => {
          let attempts = 0
          let comfyCheckCounter = 0
          const startTime = Date.now()

          pollRef.current = setInterval(async () => {
            if (abortRef.current?.signal.aborted) {
              if (pollRef.current) clearInterval(pollRef.current)
              reject(new Error('Cancelled'))
              return
            }

            const elapsed = Date.now() - startTime
            if (elapsed > maxTime) {
              if (pollRef.current) clearInterval(pollRef.current)
              reject(new Error(`Generation timed out after ${Math.round(maxTime / 60000)} minutes`))
              return
            }

            attempts++
            comfyCheckCounter++

            if (comfyCheckCounter >= 30) {
              comfyCheckCounter = 0
              const alive = await checkComfyConnection()
              if (!alive) {
                if (pollRef.current) clearInterval(pollRef.current)
                reject(new Error('ComfyUI stopped responding during generation'))
                return
              }
            }

            const elapsedSec = Math.round(elapsed / 1000)
            const expectedSteps = mode === 'video' ? steps * frames * 0.5 : steps * 2
            const pct = Math.min(10 + (attempts / expectedSteps * 85), 95)

            try {
              const history = await getHistory(promptId)
              setProgress(pct, `Generating... ${elapsedSec}s elapsed`)
              if (!history) return

              if (history.status?.completed) {
                if (pollRef.current) clearInterval(pollRef.current)
                const messages: [string, any][] = history.status?.messages ?? []
                const startMsg = messages.find(([t]) => t === 'execution_start')
                const endMsg = messages.find(([t]) => t === 'execution_success')
                const comfyTime = startMsg?.[1]?.timestamp && endMsg?.[1]?.timestamp
                  ? ((endMsg[1].timestamp - startMsg[1].timestamp) / 1000).toFixed(1) : null
                setProgress(100, 'Complete!')
                useCreateStore.getState().setLastGenTime(comfyTime ? `${comfyTime}s` : null)
                const outputs = history.outputs ?? {}
                let found = false
                for (const nodeId of Object.keys(outputs)) {
                  // Extract files from ANY keyed array, not just images/gifs/
                  // videos — custom save nodes post under other keys (audio,
                  // result, files, …); previously those outputs were dropped
                  // even though they existed on disk.
                  const files: ComfyUIOutput[] = extractComfyOutputFiles(outputs[nodeId])
                  for (const file of files) {
                    found = true
                    addToGallery({
                      id: uuid(), type: mode,
                      filename: file.filename, subfolder: file.subfolder ?? '',
                      prompt, negativePrompt, model: activeModel,
                      modelType: mode === 'image' ? imageModelType : (videoModelsList.find(m => m.name === activeModel)?.type ?? 'wan'),
                      seed: seed === -1 ? 0 : seed,
                      steps, cfgScale, sampler, scheduler, width, height, batchSize,
                      createdAt: Date.now(), builderUsed, intent,
                    })
                  }
                }
                if (!found) setError('Generation completed but no output was produced. Check ComfyUI logs.')
                resolve()
              } else if (history.status?.status_str === 'error') {
                if (pollRef.current) clearInterval(pollRef.current)
                const messages: [string, any][] = history.status?.messages ?? []
                const errorEntry = messages.find(([t]) => t === 'execution_error')
                const errMsg = errorEntry?.[1]?.exception_message
                  || errorEntry?.[1]?.message
                  || messages[messages.length - 1]?.[1]?.message
                  || 'Unknown ComfyUI error'
                const nodeType = errorEntry?.[1]?.node_type ? ` (${errorEntry[1].node_type})` : ''
                const hint = comfyErrorHint(errorEntry?.[1]?.node_type, errorEntry?.[1]?.exception_type, String(errMsg))
                reject(new Error(errMsg.trim() + nodeType + (hint ? `\n\n${hint}` : '')))
              }
            } catch (err) {
              console.warn('[useCreate] Poll error:', err)
            }
          }, 1000)
        })
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'Cancelled') {
        // User cancelled, not an error
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        useCreateStore.getState().setError(`Generation failed: ${msg}`)
        console.error('[useCreate] Generation error:', err)
      }
    } finally {
      useCreateStore.getState().setIsGenerating(false)
      useCreateStore.getState().setProgress(0)
      useCreateStore.getState().setCurrentPromptId(null)
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      abortRef.current = null
    }
  }, [videoBackend])

  // Double-click idempotence: isGenerating only flips after the first await,
  // so a second click racing the first must be blocked SYNCHRONOUSLY — two
  // fast clicks were live-reproduced queueing two ComfyUI jobs.
  const generateInFlight = useRef(false)
  const generate = useCallback(async () => {
    if (generateInFlight.current) return
    generateInFlight.current = true
    try {
      await generateInner()
    } finally {
      generateInFlight.current = false
    }
  }, [generateInner])

  const cancel = useCallback(async () => {
    abortRef.current?.abort()
    try { await cancelGeneration() } catch {}
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    useCreateStore.getState().setIsGenerating(false)
    useCreateStore.getState().setProgress(0)
    useCreateStore.getState().setCurrentPromptId(null)
    useCreateStore.getState().setError(null)
  }, [])

  return {
    connected,
    imageModels,
    videoModels: videoModelsList,
    samplerList,
    schedulerList,
    videoBackend,
    modelsLoaded,
    modelLoadError,
    checkConnection,
    fetchModels,
    runPreflight,
    generate,
    cancel,
  }
}
