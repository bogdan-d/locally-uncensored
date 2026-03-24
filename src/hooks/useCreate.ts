import { useState, useCallback, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import {
  checkComfyConnection,
  getCheckpoints,
  getDiffusionModels,
  getSamplers,
  detectVideoBackend,
  submitWorkflow,
  getHistory,
  buildTxt2ImgWorkflow,
  buildTxt2VidWorkflow,
  type ComfyUIOutput,
  type VideoBackend,
} from '../api/comfyui'
import { useCreateStore, type GalleryItem } from '../stores/createStore'

export function useCreate() {
  const store = useCreateStore()
  const [connected, setConnected] = useState<boolean | null>(null)
  const [checkpoints, setCheckpoints] = useState<string[]>([])
  const [videoModels, setVideoModels] = useState<string[]>([])
  const [samplerList, setSamplerList] = useState<string[]>([])
  const [videoBackend, setVideoBackend] = useState<VideoBackend>('none')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const checkConnection = useCallback(async () => {
    const ok = await checkComfyConnection()
    setConnected(ok)
    return ok
  }, [])

  const fetchModels = useCallback(async () => {
    const [ckpts, diffModels, samplers, vBackend] = await Promise.all([
      getCheckpoints(),
      getDiffusionModels(),
      getSamplers(),
      detectVideoBackend(),
    ])
    setCheckpoints(ckpts)
    setVideoModels(diffModels)
    setSamplerList(samplers)
    setVideoBackend(vBackend)

    if (ckpts.length > 0 && !store.model) {
      store.setModel(ckpts[0])
    }
  }, [store])

  const generate = useCallback(async () => {
    const {
      mode, prompt, negativePrompt, model, sampler, steps, cfgScale,
      width, height, seed, frames, fps,
      setIsGenerating, setProgress, setCurrentPromptId, addToGallery,
    } = useCreateStore.getState()

    if (!prompt.trim() || !model) return

    setIsGenerating(true)
    setProgress(0)

    try {
      const workflow = mode === 'video'
        ? buildTxt2VidWorkflow({ prompt, negativePrompt, model, sampler, steps, cfgScale, width, height, seed, frames, fps }, videoBackend)
        : buildTxt2ImgWorkflow({ prompt, negativePrompt, model, sampler, steps, cfgScale, width, height, seed })

      const promptId = await submitWorkflow(workflow)
      setCurrentPromptId(promptId)

      // Poll for completion
      await new Promise<void>((resolve, reject) => {
        let attempts = 0
        const maxAttempts = 1200 // 20 minutes for video (can be slow)

        pollRef.current = setInterval(async () => {
          attempts++
          if (attempts > maxAttempts) {
            clearInterval(pollRef.current!)
            reject(new Error('Generation timed out'))
            return
          }

          try {
            const history = await getHistory(promptId)
            if (!history) {
              setProgress(Math.min(attempts / (steps * 2) * 100, 95))
              return
            }

            if (history.status?.completed) {
              clearInterval(pollRef.current!)
              setProgress(100)

              // Extract outputs — check images, gifs, and videos
              const outputs = history.outputs || {}
              for (const nodeId of Object.keys(outputs)) {
                const nodeOutput = outputs[nodeId]
                const files: ComfyUIOutput[] = [
                  ...(nodeOutput.images || []),
                  ...(nodeOutput.gifs || []),
                  ...(nodeOutput.videos || []),
                ]
                for (const file of files) {
                  const galleryItem: GalleryItem = {
                    id: uuid(),
                    type: mode,
                    filename: file.filename,
                    subfolder: file.subfolder || '',
                    prompt,
                    negativePrompt,
                    model,
                    seed: seed === -1 ? 0 : seed,
                    steps,
                    cfgScale,
                    width,
                    height,
                    createdAt: Date.now(),
                  }
                  addToGallery(galleryItem)
                }
              }
              resolve()
            } else if (history.status?.status_str === 'error') {
              clearInterval(pollRef.current!)
              reject(new Error('Generation failed'))
            }
          } catch {
            // Keep polling on network errors
          }
        }, 1000)
      })
    } catch (err) {
      console.error('Generation error:', err)
    } finally {
      setIsGenerating(false)
      setProgress(0)
      setCurrentPromptId(null)
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [videoBackend])

  const cancel = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
    }
    store.setIsGenerating(false)
    store.setProgress(0)
    store.setCurrentPromptId(null)
  }, [store])

  return {
    connected,
    checkpoints,
    videoModels,
    samplerList,
    videoBackend,
    checkConnection,
    fetchModels,
    generate,
    cancel,
  }
}
