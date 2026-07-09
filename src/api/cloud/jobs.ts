// Desktop client for the hosted render queue — port of uselu's
// lib/render/cloud-jobs.ts fetch wrappers onto cloudFetch (bearer + base URL).
// Pure HTTP, no store access; useCloudCreate owns the store choreography.

import type { RenderKind, CloudQuota } from '../../lib/render/cloud-jobs'
import { cloudFetch, jsonOrError, CloudJobError } from './client'
import type { RenderOp } from '../../lib/render/cloud-jobs'

export interface CloudJobParams {
  op: RenderOp
  negative_prompt?: string
  width?: number
  height?: number
  steps?: number
  cfg?: number
  seed?: number
  frames?: number
  fps?: number
  denoise?: number
  grow_mask_by?: number
  source_path?: string
  mask_path?: string
  source_url?: string // video enhance: URL of the clip to upscale
  target_resolution?: string // upscale target (image 2k|4k|8k, video 720p|1080p|2k|4k)
}

export interface CloudJobSubmit {
  kind: RenderKind
  model: string
  prompt: string
  params: CloudJobParams
}

export interface CloudJob {
  id: string
  kind: RenderKind
  model: string
  provider: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  result_url: string | null
  attestation: { quote: string; verify_url: string } | null
  cost_units: number
  created_at: string
  started_at?: string | null
  completed_at: string | null
  error: string | null
}

export interface CloudMe {
  user: { id: string; email?: string } | null
  license: {
    status: string
    /** Canonical tier slug (hosted | hosted-pro | hosted-max | self-host). */
    tier?: string
    /** Launch gate (Max-only closed beta): false = licensed but not yet
     *  allowed in. Absent on older servers = allowed. */
    access?: boolean
  }
}

/** Stage a source image or mask; returns the render-inputs storage path. */
export async function uploadInput(file: Blob, role: 'source' | 'mask'): Promise<string> {
  const form = new FormData()
  form.append('file', file, role === 'mask' ? 'mask.png' : 'source.png')
  form.append('role', role)
  const res = await cloudFetch('/api/jobs/upload', { method: 'POST', body: form })
  const { path } = await jsonOrError<{ path: string }>(res)
  return path
}

export async function submitCloudJob(
  submit: CloudJobSubmit,
): Promise<{ id: string; quota: { cost: number; used: number; limit: number } }> {
  const res = await cloudFetch('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(submit),
  })
  return jsonOrError(res)
}

export async function getJob(id: string): Promise<CloudJob> {
  const res = await cloudFetch(`/api/jobs/${encodeURIComponent(id)}`)
  const { job } = await jsonOrError<{ job: CloudJob }>(res)
  return job
}

export async function cancelJob(id: string): Promise<{ status: string; refunded?: boolean }> {
  const res = await cloudFetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  return jsonOrError(res)
}

export async function getQuota(): Promise<CloudQuota> {
  const res = await cloudFetch('/api/jobs/quota')
  return jsonOrError(res)
}

/** Account probe — logged-out is a valid state, not an error. */
export async function getMe(): Promise<CloudMe> {
  const res = await cloudFetch('/api/me')
  return jsonOrError(res)
}

/** Re-fetch the job for a fresh signed result URL (they expire ~1 h after the
 *  last read; /api/jobs/[id] re-signs on every GET). Video gallery items keep
 *  remoteUrl + jobId and refresh lazily through this. */
export async function refreshResultUrl(jobId: string): Promise<string | null> {
  try {
    const job = await getJob(jobId)
    return job.result_url
  } catch {
    return null
  }
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])

/** Poll until the job reaches a terminal state, the timeout hits, or the
 *  AbortSignal fires. onTick fires on every poll with the fresh job. */
export async function pollJob(
  id: string,
  opts: {
    signal?: AbortSignal
    intervalMs?: number
    timeoutMs?: number
    onTick?: (job: CloudJob) => void
  } = {},
): Promise<CloudJob> {
  const intervalMs = opts.intervalMs ?? 2_500
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000)
  for (;;) {
    if (opts.signal?.aborted) throw new CloudJobError('polling aborted', 0)
    const job = await getJob(id)
    opts.onTick?.(job)
    if (TERMINAL.has(job.status)) return job
    if (Date.now() >= deadline) throw new CloudJobError('render timed out', 0)
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs)
      opts.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          resolve()
        },
        { once: true },
      )
    })
  }
}

export { CloudJobError }
