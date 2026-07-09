// Cloud twin of useCreate's generate/cancel — port of uselu's useCloudCreate
// onto the desktop cloud client (bearer auth via api/cloud/jobs). Submits the
// current Create state to the hosted render queue instead of local ComfyUI,
// then polls to completion. Store choreography (isGenerating, progress,
// gallery) mirrors the local path so every downstream component works
// unchanged. useCreate itself is untouched: the seam lives in CreateExpProvider.
//
// Desktop delta vs uselu: image results are downloaded into a self-contained
// dataUrl gallery item (signed URLs expire — the local copy never rots and
// works offline). Videos would blow localStorage as base64, so they keep
// remoteUrl + jobId and re-sign lazily via refreshResultUrl().

import { useCallback, useRef } from 'react'
import { useCreateStore } from '../stores/createStore'
import { intentToJob } from '../lib/render/cloud-jobs'
import {
  cancelJob,
  pollJob,
  submitCloudJob,
  uploadInput,
  CloudJobError,
  type CloudJobParams,
} from '../api/cloud/jobs'
import { defaultCloudModel, cloudMediaLive } from '../stores/cloudCatalogStore'
import { checkPromptSafety, SAFETY_BLOCK_MESSAGE } from '../lib/render/safety'

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl)
  return res.blob()
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

export function useCloudCreate(opts: { onQuotaChange?: () => void } = {}) {
  const activeJob = useRef<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const { onQuotaChange } = opts

  const generate = useCallback(async () => {
    const s = useCreateStore.getState()
    if (s.isGenerating) return
    const intent = s.intent()
    const { kind, op } = intentToJob(intent)
    const model =
      (kind === 'video' ? s.cloudVideoModel : s.cloudImageModel) || defaultCloudModel(kind).id

    s.setError(null)
    if (!cloudMediaLive()) {
      // Server MEDIA_LIVE switch is off — the GPU fleet isn't up, a submit
      // would only 503. Mirror the server's honest "coming soon".
      s.setError('Cloud rendering is coming soon — the GPU fleet is not live yet.')
      return
    }
    if (op === 'generate' && s.prompt.trim().length === 0) {
      s.setError('Please enter a prompt.')
      return
    }
    // Client-side CSAM gate (UX). The server additionally enforces its
    // SFW-cloud policy — its 422 message lands in setError below.
    if (checkPromptSafety(`${s.prompt} ${s.negativePrompt}`).blocked) {
      s.setError(SAFETY_BLOCK_MESSAGE)
      return
    }
    if (op !== 'generate' && !s.source) {
      s.setError('Add a source image first.')
      return
    }

    s.setIsGenerating(true)
    s.setProgressPhase('queued')
    s.setProgress(5, 'Uploading inputs…')

    try {
      const params: CloudJobParams = {
        op,
        negative_prompt: s.negativePrompt || undefined,
        width: s.width,
        height: s.height,
        steps: s.steps,
        cfg: s.cfgScale,
        seed: s.seed === -1 ? undefined : s.seed,
      }
      if (kind === 'video') {
        params.frames = s.frames
        params.fps = s.fps
      }
      if (op === 'edit') {
        params.denoise = s.denoise
        params.grow_mask_by = s.growMaskBy
      }
      // ImageRef.url is always a data URL preview; the cloud path re-uploads
      // from it, so a source picked while on the local backend still works.
      if (op !== 'generate' && s.source) {
        params.source_path = await uploadInput(await dataUrlToBlob(s.source.url), 'source')
      }
      if (op === 'edit') {
        if (!s.mask) {
          s.setError('Paint a mask first — the edit only changes the painted area.')
          s.setIsGenerating(false)
          return
        }
        params.mask_path = await uploadInput(await dataUrlToBlob(s.mask.url), 'mask')
      }

      s.setProgress(10, 'Submitting to the render queue…')
      const { id } = await submitCloudJob({ kind, model, prompt: s.prompt, params })
      activeJob.current = id
      abort.current = new AbortController()
      onQuotaChange?.()
      if (s.prompt.trim()) s.addToPromptHistory(s.prompt.trim())

      const startedAt = Date.now()
      // Video renders routinely run several minutes and can queue behind
      // other jobs on the shared fleet — give them a much longer client
      // deadline than images.
      const job = await pollJob(id, {
        timeoutMs: kind === 'video' ? 45 * 60_000 : 15 * 60_000,
        signal: abort.current.signal,
        onTick: (j) => {
          const st = useCreateStore.getState()
          const elapsed = Math.round((Date.now() - startedAt) / 1000)
          if (j.status === 'queued') {
            st.setProgressPhase('queued')
            st.setProgress(15, `Waiting for a cloud GPU… ${elapsed}s`)
          } else if (j.status === 'running') {
            st.setProgressPhase('sampling')
            st.setProgress(Math.min(90, 20 + elapsed), `Rendering in the cloud… ${elapsed}s`)
          }
        },
      })

      const st = useCreateStore.getState()
      if (job.status === 'succeeded' && job.result_url) {
        st.setProgressPhase('complete')
        st.setProgress(100, 'Complete!')
        // Images: pull the bytes now — the local copy never expires.
        const dataUrl = kind === 'image' ? await fetchAsDataUrl(job.result_url) : null
        st.addToGallery({
          id: job.id,
          type: kind,
          filename: '',
          subfolder: '',
          prompt: s.prompt,
          negativePrompt: s.negativePrompt,
          model,
          modelType: 'unknown',
          seed: s.seed === -1 ? 0 : s.seed,
          steps: s.steps,
          cfgScale: s.cfgScale,
          sampler: s.sampler,
          scheduler: s.scheduler,
          width: s.width,
          height: s.height,
          batchSize: 1,
          createdAt: Date.now(),
          ...(dataUrl ? { dataUrl } : { remoteUrl: job.result_url }),
          attestation: job.attestation,
          jobId: job.id,
          intent,
        })
      } else if (job.status === 'canceled') {
        st.setError(null)
      } else {
        st.setError(job.error ?? 'Cloud render failed.')
        onQuotaChange?.() // failure refunds — refresh the meter
      }
    } catch (err) {
      const st = useCreateStore.getState()
      if (err instanceof CloudJobError && err.status === 429) {
        st.setError('Monthly credit budget exhausted — upgrade your plan or wait for the next period.')
      } else if (err instanceof CloudJobError && err.status === 401) {
        st.setError('Sign in to your LU Cloud account to render in the cloud.')
      } else if (err instanceof CloudJobError && err.message === 'render timed out') {
        st.setError('Still rendering — this is taking longer than expected. It will appear in your history when it completes.')
      } else if (!(err instanceof CloudJobError && err.message === 'polling aborted')) {
        st.setError(err instanceof Error ? err.message : String(err))
      }
      onQuotaChange?.()
    } finally {
      activeJob.current = null
      abort.current = null
      const st = useCreateStore.getState()
      st.setIsGenerating(false)
      st.setProgress(0)
    }
  }, [onQuotaChange])

  const cancel = useCallback(async () => {
    const id = activeJob.current
    abort.current?.abort() // stop polling immediately either way
    if (!id) return
    try {
      await cancelJob(id)
      onQuotaChange?.() // queued-cancel refunds
    } catch {
      // 409 (already running/finished) — poll stop is all the client can do
    }
  }, [onQuotaChange])

  return { generate, cancel }
}
