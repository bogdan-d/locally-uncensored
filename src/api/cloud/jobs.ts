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
  source_url?: string // video enhance/extend: URL of the clip to re-process
  target_resolution?: string // upscale target (image 2k|4k|8k, video 720p|1080p)
  // ── 2.5.8 categories ──
  audio_path?: string // lipsync speech / voice-clone reference (staged upload)
  audio_url?: string // lipsync speech from a prior OWN render (tts/music result)
  video_path?: string // lipsync base clip / motion driving video (staged upload)
  image_paths?: string[] // character training set (4-30 staged uploads)
  duration?: number // music track seconds (billed per second)
  lyrics?: string // music: optional lyrics
  voice?: string // tts: named voice
  voice_description?: string // tts voice-design
  trigger_word?: string // character training
  name?: string // character shelf label
  loras?: { id: string; scale?: number }[] // OWN user_loras rows — server resolves to URLs
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

/** Stage an input; returns the render-inputs storage path. Roles: 'source' /
 *  'mask' (images), and since 2.5.8 'train' (one character-training image per
 *  call), 'audio' (speech / voice reference) and 'video' (base/driving clip).
 *  Sends the raw bytes (role in the query) rather than multipart/form-data:
 *  WKWebView's fetch fails a cross-origin FormData(Blob) body with a bare
 *  "Load failed", which broke every source-needing op (edit/removebg/eraser/
 *  upscale/animate). An ArrayBuffer body serialises fine. */
export async function uploadInput(
  file: Blob,
  role: 'source' | 'mask' | 'train' | 'audio' | 'video',
): Promise<string> {
  const body = await file.arrayBuffer()
  const res = await cloudFetch(`/api/jobs/upload?role=${role}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  })
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}

/** Consecutive getJob failures pollJob rides out before giving up. */
const MAX_POLL_FAILURES = 5

/** Poll until the job reaches a terminal state, the timeout hits, or the
 *  AbortSignal fires. onTick fires on every poll with the fresh job.
 *  A transient getJob failure (network blip, one 5xx, a token-refresh hiccup)
 *  must not detach the client from a 15–45 minute render that keeps running
 *  and billing server-side — the loop retries with backoff and only gives up
 *  after MAX_POLL_FAILURES consecutive errors. Definitive client errors
 *  (4xx except 401/408/429) fail fast. */
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
  let failures = 0
  for (;;) {
    if (opts.signal?.aborted) throw new CloudJobError('polling aborted', 0)
    let job: CloudJob
    try {
      job = await getJob(id)
      failures = 0
    } catch (err) {
      // 401 stays retryable: a failed lazy token refresh yields one mid-poll
      // and must not tell a signed-in user to sign in.
      const status = err instanceof CloudJobError ? err.status : 0
      const definitive =
        status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429
      failures += 1
      if (definitive || failures >= MAX_POLL_FAILURES) throw err
      if (Date.now() >= deadline) throw new CloudJobError('render timed out', 0)
      await sleep(Math.min(intervalMs * failures, 15_000), opts.signal)
      continue
    }
    opts.onTick?.(job)
    if (TERMINAL.has(job.status)) return job
    if (Date.now() >= deadline) throw new CloudJobError('render timed out', 0)
    await sleep(intervalMs, opts.signal)
  }
}

export { CloudJobError }
