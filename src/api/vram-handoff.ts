/**
 * Feature EE (v2.5.0) — VRAM hand-off orchestrator for image/video generation.
 *
 * The problem: the local text model (Ollama) and the ComfyUI image/video model
 * both want the GPU. On a single-GPU machine with, say, 12 GB VRAM, a resident
 * 14 B chat model (~9 GB) plus a FLUX/Wan pipeline (~10 GB+) does not fit — the
 * second one to load OOMs. Pre-EE the agent's `image_generate` would just hand
 * the OOM straight back as "generation failed", which read as a broken feature.
 *
 * The fix: when (and ONLY when) the resident text model + the image/video
 * footprint won't co-exist, evict the text model from VRAM first, run the
 * generation, then reload the text model afterwards. The conversation itself
 * lives in chatStore and is never touched — unloading an Ollama model discards
 * only its KV cache (a one-message re-eval cost on the next turn), NOT any
 * message history. The LLM is stateless; "state preservation" here means we
 * never lose the chat, we just pay a small warm-up on the next reply.
 *
 * HONEST UX: this is an OOM-avoidance + state-preservation mechanism, NOT a
 * speed feature. A warm swap is ~30-90 s; a cold ComfyUI start is longer. The
 * VramSwitchCard + the tool descriptions say so plainly — we never imply a
 * zero-latency "seamless" experience.
 *
 * Sequence (vramHandoffGenerate):
 *   (a) DECIDE   — pure, no side effects. Resolve the target image/video model
 *                  and the text model to reload. Cloud/remote text models hold
 *                  no local VRAM → skip all juggling. decideUnload() does the
 *                  fits-or-not math, governed by settings.exclusiveVramMode.
 *   (b) HANDOFF-OUT — only when unloading: capture resident models, unload the
 *                  text model, then POLL /api/ps until it's actually gone (race
 *                  guard: do NOT start ComfyUI until Ollama confirms eviction).
 *   (c) GENERATE — start ComfyUI if needed (poll until up), build the workflow
 *                  (image: buildDynamicWorkflow; video: buildTxt2VidWorkflow),
 *                  submit, poll history, extract outputs. ComfyUI errors are
 *                  surfaced VERBATIM (an OOM must read as an OOM, not "failed").
 *   (d) HANDOFF-BACK — in `finally` (runs on success/failure/timeout): freeMemory
 *                  then best-effort loadModel(textModel) (non-fatal — Ollama
 *                  lazy-loads on the next message anyway).
 *   (e) RETURN   — the SAME string shape as the legacy image_generate so
 *                  ToolCallBlock renders it inline and useAgentChat feeds it
 *                  back to the model unchanged.
 *
 * A module-level in-flight mutex serialises calls so a 2nd generation awaits
 * the first — without it, the finally-reload of call #1 could fire mid-generation
 * of call #2 and re-trigger the exact OOM we are avoiding.
 */

import { backendCall, ollamaUrl, localFetch, isOllamaLocal } from './backend'
import { listRunningModels, loadModel, unloadModel } from './ollama'
import { useSettingsStore } from '../stores/settingsStore'
import {
  getImageModels,
  getVideoModels,
  detectVideoBackend,
  getSystemVRAM,
  submitWorkflow,
  getHistory,
  freeMemory,
  extractComfyOutputFiles,
  getImageUrl,
  classifyModel,
  isI2VModel,
  uploadImage,
  buildTxt2VidWorkflow,
  snapToVideoGrid,
  MODEL_TYPE_DEFAULTS,
  type VideoBackend,
} from './comfyui'
import { getActiveAgentModel } from './agent-context'
import { log } from '../lib/logger'

export type HandoffPhase =
  | 'deciding'
  | 'freeing_vram'
  | 'loading_image_model'
  | 'generating'
  | 'restoring_text'
  | 'done'
  | 'error'

export interface HandoffEventDetail {
  phase: HandoffPhase
  /** 'image' | 'video' — which generation kind is in flight. */
  kind?: 'image' | 'video'
  /** Free-text detail for the card (e.g. a model name or an error message). */
  detail?: string
  /** True only on the final 'done'/'error' so the card knows to fade out. */
  terminal?: boolean
}

// ── Status channel (pure TS, no Rust round-trip) ──────────────────
//
// A tiny browser EventTarget the orchestrator pushes phase events onto. The
// VramSwitchCard subscribes via useVramHandoff. Emitting is best-effort and
// NEVER throws — in a non-DOM context (vitest node env) `EventTarget` may be
// unavailable, so we guard creation and swallow any failure. The orchestrator
// must keep working with or without a UI listening.

export const HANDOFF_EVENT = 'lu-vram-handoff'

let _channel: EventTarget | null = null
function getChannel(): EventTarget | null {
  if (_channel) return _channel
  try {
    if (typeof EventTarget !== 'undefined') {
      _channel = new EventTarget()
      return _channel
    }
  } catch { /* no EventTarget in this runtime */ }
  return null
}

/** Subscribe to hand-off phase events. Returns an unsubscribe fn (no-op if unavailable). */
export function onHandoff(listener: (d: HandoffEventDetail) => void): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const wrapped = (e: Event) => {
    const detail = (e as CustomEvent<HandoffEventDetail>).detail
    if (detail) listener(detail)
  }
  ch.addEventListener(HANDOFF_EVENT, wrapped as EventListener)
  return () => ch.removeEventListener(HANDOFF_EVENT, wrapped as EventListener)
}

/** Emit a phase event. No-throw — a failed emit must never break a generation. */
function emitHandoff(phase: HandoffPhase, opts?: Omit<HandoffEventDetail, 'phase'>): void {
  try {
    const ch = getChannel()
    if (!ch) return
    const terminal = phase === 'done' || phase === 'error'
    const evt = new CustomEvent<HandoffEventDetail>(HANDOFF_EVENT, {
      detail: { phase, terminal, ...opts },
    })
    ch.dispatchEvent(evt)
  } catch { /* best effort */ }
}

// ── Resident-model VRAM probe (/api/ps) ───────────────────────────
//
// listRunningModels() in ollama.ts throws away the per-model sizes, but the
// fits-or-not decision needs `size_vram` (bytes of the model actually resident
// in GPU memory). So we hit /api/ps directly here, mirroring that function's
// transport + soft-fail-to-empty behaviour.

interface ResidentModel {
  name: string
  /** Bytes of this model currently resident in VRAM (0 if CPU-only / unknown). */
  sizeVram: number
}

async function getResidentModels(): Promise<ResidentModel[]> {
  try {
    // Short cap: /api/ps is a quick status read. Bounding it keeps the DECIDE
    // phase from inheriting the proxy's 5-min default if Ollama is wedged.
    const res = await localFetch(ollamaUrl('/ps'), { timeoutMs: 8_000 })
    if (!res.ok) return []
    const data = await res.json()
    return (data.models || []).map((m: any) => ({
      name: m.name || m.model || '',
      sizeVram: typeof m.size_vram === 'number' ? m.size_vram : 0,
    }))
  } catch {
    return []
  }
}

// ── Footprint estimate for the image/video model ──────────────────
//
// We don't know the exact runtime VRAM a ComfyUI pipeline will take before we
// run it (it depends on resolution, dtype, the VAE, text encoder, etc.), so we
// use a conservative per-architecture estimate in GB. The number is the
// *checkpoint/diffusion + typical aux* footprint — deliberately on the high
// side so 'auto' errs toward freeing rather than toward an OOM. These are
// estimates, not measurements (Bug-G lesson: only live E2E confirms the real
// number on a given GPU); they exist solely to make the fits/doesn't-fit
// comparison meaningful, never to gate the generation hard.
const MODEL_FOOTPRINT_GB: Record<string, number> = {
  // Image
  sd15: 4,
  sdxl: 8,
  flux: 16,
  flux2: 22,
  zimage: 12,
  ernie_image: 18,
  // Video (heavier — UNet + VAE + big text encoder all resident)
  wan: 18,
  hunyuan: 20,
  ltx: 12,
  mochi: 22,
  cosmos: 24,
  cogvideo: 18,
  svd: 12,
  framepack: 18,
  pyramidflow: 16,
  allegro: 20,
}

/** Best-effort footprint for a model name. Unknown → null (caller treats as unknown). */
export function estimateModelFootprintGB(modelName: string): number | null {
  const type = classifyModel(modelName)
  return MODEL_FOOTPRINT_GB[type] ?? null
}

export type ExclusiveVramMode = 'auto' | 'always' | 'never'

export interface DecideUnloadInput {
  /** Bytes of text model currently resident in VRAM (from /api/ps size_vram). 0/undefined = unknown. */
  textVramBytes: number | undefined
  /** Estimated image/video footprint in GB (from estimateModelFootprintGB). null = unknown. */
  modelFootprintGB: number | null
  /** Total system VRAM in GB (from getSystemVRAM). null = unknown. */
  systemVramGB: number | null
  /** Governing setting. */
  mode: ExclusiveVramMode
}

export interface DecideUnloadResult {
  unload: boolean
  reason: string
}

const BYTES_PER_GB = 1024 * 1024 * 1024

/**
 * Pure decision: should we evict the text model before generating?
 *
 *   - mode 'never'  → never unload (user opted out of juggling).
 *   - mode 'always' → always unload when there IS a resident text model.
 *   - mode 'auto'   → unload only when the math says they won't co-exist:
 *                     (textVram + footprint) > systemVram. If ANY input is
 *                     unknown we DON'T unload — better to attempt the gen and
 *                     surface a real OOM than to evict the user's model on a
 *                     guess (the unload itself costs a re-eval next turn).
 *
 * Exported + side-effect-free so the unit tests can exhaustively cover the
 * fits / doesn't-fit / unknown matrix without any live services.
 */
export function decideUnload(input: DecideUnloadInput): DecideUnloadResult {
  const { textVramBytes, modelFootprintGB, systemVramGB, mode } = input

  if (mode === 'never') {
    return { unload: false, reason: 'exclusiveVramMode=never' }
  }

  const textGB = textVramBytes && textVramBytes > 0 ? textVramBytes / BYTES_PER_GB : 0

  if (mode === 'always') {
    // Only meaningful to unload if the text model is actually resident in VRAM.
    if (textGB > 0) return { unload: true, reason: 'exclusiveVramMode=always (text model resident)' }
    return { unload: false, reason: 'exclusiveVramMode=always but no text model resident in VRAM' }
  }

  // mode === 'auto'
  if (textGB <= 0) {
    return { unload: false, reason: 'auto: no text model resident in VRAM (nothing to free)' }
  }
  if (modelFootprintGB == null || systemVramGB == null) {
    // Unknown sizes → don't unload on auto. Attempt the gen; if it OOMs the
    // user sees the verbatim ComfyUI error and can switch to 'always'.
    return { unload: false, reason: 'auto: unknown footprint or system VRAM — not unloading on a guess' }
  }
  const needed = textGB + modelFootprintGB
  if (needed > systemVramGB) {
    return {
      unload: true,
      reason: `auto: text ${textGB.toFixed(1)}GB + model ${modelFootprintGB}GB = ${needed.toFixed(1)}GB > ${systemVramGB}GB VRAM`,
    }
  }
  return {
    unload: false,
    reason: `auto: text ${textGB.toFixed(1)}GB + model ${modelFootprintGB}GB = ${needed.toFixed(1)}GB fits in ${systemVramGB}GB VRAM`,
  }
}

// ── ComfyUI lifecycle helpers ─────────────────────────────────────

interface ComfyStatus {
  running?: boolean
  starting?: boolean
  found?: boolean
}

async function comfyIsRunning(): Promise<boolean> {
  try {
    const s = await backendCall<ComfyStatus>('comfyui_status')
    return !!s?.running
  } catch {
    return false
  }
}

/**
 * Ensure ComfyUI is up. If `comfyui_status` already reports running, return
 * immediately. Otherwise fire `start_comfyui` and poll status until running or
 * the cold-start budget (~90 s) elapses. Non-fatal: returns false on timeout so
 * the caller can still attempt the workflow (the submit will surface a clear
 * connection error if ComfyUI truly never came up).
 */
async function ensureComfyRunning(timeoutMs = 90_000): Promise<boolean> {
  if (await comfyIsRunning()) return true
  try {
    await backendCall('start_comfyui')
  } catch (e) {
    log.warn('vram_handoff.start_comfyui_failed', { err: String(e) })
    // Fall through to poll anyway — it may already be starting.
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1500)
    if (await comfyIsRunning()) return true
  }
  return false
}

/**
 * Race guard: after unloadModel(textModel), poll /api/ps until that model is no
 * longer resident (or timeout). Starting ComfyUI before Ollama has actually
 * released the VRAM defeats the whole point — the two would briefly co-exist
 * and OOM. 15 s is generous; a `keep_alive:0` evict is usually sub-second.
 */
export async function pollGone(modelName: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  // Check immediately first (cheap) before sleeping.
  for (;;) {
    let running: string[]
    try {
      running = await listRunningModels()
    } catch {
      running = []
    }
    if (!running.includes(modelName)) return true
    if (Date.now() >= deadline) return false
    await sleep(750)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── In-flight mutex ───────────────────────────────────────────────
//
// One generation at a time. A 2nd call chains onto the 1st's promise so the
// reload-in-finally of call #1 can never overlap the generate of call #2.
let _inFlight: Promise<unknown> = Promise.resolve()

// ── Public orchestrator ───────────────────────────────────────────

export interface VramHandoffArgs {
  prompt?: string
  negativePrompt?: string
  model?: string
  // Image-to-image / image-to-video: a filename from a prior generate result.
  inputImage?: string
  // Image-to-image denoise strength (0.05–1.0).
  denoise?: number
  // Video-only
  frames?: number
  fps?: number
  [k: string]: unknown
}

/**
 * Orchestrate one image/video generation with VRAM hand-off. Always resolves to
 * a result string (never rejects) so the agent loop gets a clean tool message.
 */
export async function vramHandoffGenerate(kind: 'image' | 'video', args: VramHandoffArgs): Promise<string> {
  // Serialise. We park on the previous call's settled promise (success OR
  // failure — `.catch` swallows so a prior error doesn't reject our chain),
  // then run our own body and expose it as the new tail.
  const run = _inFlight
    .catch(() => {})
    .then(() => runHandoff(kind, args))
    // Defensive: runHandoff is written to always RETURN a string (the finally
    // block never rethrows), but if anything unexpected slips through we still
    // hand the agent a clean tool message instead of rejecting the chain.
    .catch((e) => `${kind === 'video' ? 'Video' : 'Image'} generation failed: ${e instanceof Error ? e.message : String(e)}`)
  _inFlight = run.catch(() => {})
  return run
}

async function runHandoff(kind: 'image' | 'video', args: VramHandoffArgs): Promise<string> {
  const prompt = String(args.prompt ?? args.description ?? '').trim()
  if (!prompt) return `Error: No prompt provided for ${kind} generation.`

  emitHandoff('deciding', { kind })

  // ── (a) DECIDE — resolve target model (no side effects yet) ──────
  let targetModel: string
  let videoBackend: VideoBackend = 'none'
  try {
    if (kind === 'image') {
      const models = await getImageModels()
      if (models.length === 0) {
        emitHandoff('error', { kind, detail: 'no image model installed' })
        return 'Error: No image model installed in ComfyUI. Download one from the Create tab (Model Manager) and try again.'
      }
      targetModel = typeof args.model === 'string' && args.model ? args.model : models[0].name
    } else {
      const [models, backend] = await Promise.all([getVideoModels(), detectVideoBackend()])
      const wantI2V = typeof args.inputImage === 'string' && !!args.inputImage
      if (wantI2V) {
        // Image-to-video needs an I2V-capable model (SVD / FramePack). Those use
        // built-in ComfyUI nodes, so a 'none' text-to-video backend is fine here.
        const i2vModels = models.filter((m) => isI2VModel(m.name))
        if (i2vModels.length === 0) {
          emitHandoff('error', { kind, detail: 'no i2v model installed' })
          return 'Error: Image-to-video needs an I2V model such as SVD. Install one from Models → Discover (e.g. "SVD-XT 1.1 — Image to Video"), then try again.'
        }
        targetModel = typeof args.model === 'string' && args.model ? args.model : i2vModels[0].name
        videoBackend = backend
      } else {
        if (models.length === 0 || backend === 'none') {
          emitHandoff('error', { kind, detail: 'no video model installed' })
          return 'Error: No video model installed in ComfyUI (need a Wan/Hunyuan model or AnimateDiff nodes). Download one from the Create tab and try again.'
        }
        targetModel = typeof args.model === 'string' && args.model ? args.model : models[0].name
        videoBackend = backend
      }
    }
  } catch (e) {
    // ComfyUI unreachable while listing models — we have not unloaded anything,
    // so just report it. Don't mask the connection failure.
    emitHandoff('error', { kind, detail: String(e) })
    return `Error: Could not query ComfyUI models — ${e instanceof Error ? e.message : String(e)}. Is ComfyUI installed and reachable?`
  }

  // Which text model do we reload afterwards? From the active agent loop.
  const active = getActiveAgentModel()
  // Cloud (openai/anthropic/openrouter/...) OR a remote Ollama base hold NO
  // local VRAM — there is nothing to free or restore, so skip all juggling and
  // just generate. `active.remote` is set by useAgentChat from the Ollama base
  // host; providerId !== 'ollama' covers the cloud providers.
  const textIsLocalOllama =
    !!active && active.providerId === 'ollama' && active.remote === false && isOllamaLocal()
  const textModel = textIsLocalOllama ? active!.name : null

  // ── Decide unload (only relevant for a local Ollama text model) ──
  let willUnload = false
  if (textModel) {
    try {
      const [resident, footprint, systemVram, mode] = await Promise.all([
        getResidentModels(),
        Promise.resolve(estimateModelFootprintGB(targetModel)),
        getSystemVRAM(),
        Promise.resolve(getExclusiveVramMode()),
      ])
      const textEntry = resident.find((m) => m.name === textModel)
      const decision = decideUnload({
        textVramBytes: textEntry?.sizeVram,
        modelFootprintGB: footprint,
        systemVramGB: systemVram,
        mode,
      })
      willUnload = decision.unload
      log.info('vram_handoff.decision', { kind, targetModel, textModel, ...decision })
    } catch (e) {
      // Decision probe failed — default to NOT unloading (safer; attempt gen).
      log.warn('vram_handoff.decision_failed', { err: String(e) })
      willUnload = false
    }
  }

  // Capture resident text models BEFORE unload so the reload target is honest
  // even if `active` was somehow stale.
  let evictedModel: string | null = null

  try {
    // ── (b) HANDOFF-OUT — only if we decided to unload ─────────────
    if (willUnload && textModel) {
      emitHandoff('freeing_vram', { kind, detail: textModel })
      // Confirm it's actually resident right now (capture-before-unload).
      let runningBefore: string[]
      try {
        runningBefore = await listRunningModels()
      } catch {
        runningBefore = []
      }
      if (runningBefore.includes(textModel)) {
        try {
          await unloadModel(textModel)
          evictedModel = textModel
        } catch (e) {
          // Unload failed — don't block the gen, but log. ComfyUI may still OOM;
          // that error will surface verbatim below.
          log.warn('vram_handoff.unload_failed', { textModel, err: String(e) })
        }
        // RACE GUARD: wait until /api/ps confirms eviction before touching ComfyUI.
        if (evictedModel) {
          const gone = await pollGone(evictedModel)
          if (!gone) {
            log.warn('vram_handoff.evict_timeout', { textModel: evictedModel })
          }
        }
      }
    }

    // ── (c) GENERATE ───────────────────────────────────────────────
    emitHandoff('loading_image_model', { kind, detail: targetModel })
    const up = await ensureComfyRunning()
    if (!up) {
      // Surface clearly; the finally block still restores the text model.
      emitHandoff('error', { kind, detail: 'ComfyUI did not start' })
      return 'Error: ComfyUI did not start within 90s. Start it from the Create tab and try again.'
    }

    emitHandoff('generating', { kind, detail: targetModel })

    const result = kind === 'image'
      ? await generateImage(prompt, targetModel, args)
      : await generateVideo(prompt, targetModel, videoBackend, args)
    return result
  } finally {
    // ── (d) HANDOFF-BACK — ALWAYS (success, failure, timeout) ──────
    // Free ComfyUI's VRAM first (so the text model has room to reload), then
    // best-effort reload the text model. The reload is non-fatal: if it throws,
    // Ollama will lazy-load on the user's next message anyway.
    emitHandoff('restoring_text', { kind, detail: evictedModel ?? undefined })
    try {
      await freeMemory()
    } catch { /* best effort */ }
    if (evictedModel) {
      try {
        await loadModel(evictedModel)
      } catch (e) {
        log.warn('vram_handoff.reload_failed', { textModel: evictedModel, err: String(e) })
      }
    }
    emitHandoff('done', { kind })
  }
}

// ── Generation bodies ─────────────────────────────────────────────

/** Image path — mirrors the legacy executeImageGenerate, via buildDynamicWorkflow. */
async function generateImage(prompt: string, model: string, args: VramHandoffArgs): Promise<string> {
  const { buildDynamicWorkflow } = await import('./dynamic-workflow')
  try {
    // Image-to-image: resolve the referenced output image into ComfyUI's input
    // folder, then let buildDynamicWorkflow wire LoadImage → VAEEncode + denoise.
    let inputImage: string | undefined
    let denoise: number | undefined
    if (typeof args.inputImage === 'string' && args.inputImage) {
      inputImage = await resolveInputImage(args.inputImage)
      denoise = clampFloat(args.denoise, 0.6, 0.05, 1.0)
    }
    const workflow = await buildDynamicWorkflow(
      {
        prompt,
        negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
        model,
        sampler: 'euler',
        scheduler: 'normal',
        steps: 20,
        cfgScale: 7,
        width: 1024,
        height: 1024,
        seed: -1,
        batchSize: 1,
        ...(inputImage ? { inputImage, denoise } : {}),
      },
      classifyModel(model),
    )
    // Phase markers (chat-agent hang 2026-06-03): make it obvious in the log
    // whether a stall is in the workflow build (/object_info) or the submit
    // (/prompt). Both are now timeout-bounded, so neither can strand the
    // hand-off with the text model unloaded — these logs just pinpoint where.
    log.info('vram_handoff.image.submit', { model, i2i: !!inputImage })
    const promptId = await submitWorkflow(workflow)
    log.info('vram_handoff.image.submitted', { promptId })
    return await pollAndExtract(promptId, prompt, label('image'), getImageTimeoutMs())
  } catch (err) {
    // Surface ComfyUI's message verbatim — an OOM must NOT be masked.
    return `${label('image')} generation failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Video path — buildTxt2VidWorkflow with MODEL_TYPE_DEFAULTS + snapToVideoGrid. */
async function generateVideo(
  prompt: string,
  model: string,
  backend: VideoBackend,
  args: VramHandoffArgs,
): Promise<string> {
  try {
    const type = classifyModel(model)

    // ── Image-to-video (SVD / FramePack) ───────────────────────────
    // Resolve the still into ComfyUI's input folder and route through the
    // dynamic builder's I2V strategy. Conservative size + low frame count keep
    // it inside 12 GB; SVD bundles its own CLIP-vision + VAE in the checkpoint.
    if (typeof args.inputImage === 'string' && args.inputImage && isI2VModel(model)) {
      const { buildDynamicWorkflow } = await import('./dynamic-workflow')
      const inputImage = await resolveInputImage(args.inputImage)
      const frames = clampInt(args.frames, 14, 1, 25)
      const fps = clampInt(args.fps, 8, 1, 30)
      const workflow = await buildDynamicWorkflow(
        {
          prompt,
          negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
          model,
          sampler: 'euler',
          scheduler: 'normal',
          steps: 20,
          cfgScale: 3,
          width: 768,
          height: 448,
          seed: -1,
          batchSize: 1,
          frames,
          fps,
          inputImage,
        },
        type,
      )
      log.info('vram_handoff.video.submit', { model, i2v: true })
      const promptId = await submitWorkflow(workflow)
      log.info('vram_handoff.video.submitted', { promptId })
      return await pollAndExtract(promptId, prompt, label('video'), getVideoTimeoutMs())
    }

    // ── Text-to-video ──────────────────────────────────────────────
    const defaults = MODEL_TYPE_DEFAULTS[type] ?? MODEL_TYPE_DEFAULTS.wan
    const snapped = snapToVideoGrid(defaults.width, defaults.height)
    const frames = clampInt(args.frames, defaults.frames, 1, 256)
    const fps = clampInt(args.fps, defaults.fps, 1, 60)

    const workflow = await buildTxt2VidWorkflow(
      {
        prompt,
        negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
        model,
        sampler: defaults.sampler,
        scheduler: defaults.scheduler,
        steps: defaults.steps,
        cfgScale: defaults.cfg,
        width: snapped.width,
        height: snapped.height,
        seed: -1,
        batchSize: 1,
        frames,
        fps,
      },
      backend,
    )
    log.info('vram_handoff.video.submit', { model, i2v: false, backend })
    const promptId = await submitWorkflow(workflow)
    log.info('vram_handoff.video.submitted', { promptId })
    return await pollAndExtract(promptId, prompt, label('video'), getVideoTimeoutMs())
  } catch (err) {
    return `${label('video')} generation failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Poll ComfyUI history until the prompt completes, then build the result string
 * in the exact legacy shape so ToolCallBlock renders it inline and useAgentChat
 * feeds it back to the model unchanged. On a ComfyUI-side error, surface the
 * message VERBATIM (Bug-G / honest-UX: an OOM reads as an OOM).
 */
async function pollAndExtract(promptId: string, prompt: string, kindLabel: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1000)
    const history = await getHistory(promptId)
    if (history?.status?.completed) {
      const outputs = history.outputs ?? {}
      for (const nodeId of Object.keys(outputs)) {
        const files = extractComfyOutputFiles(outputs[nodeId])
        if (files.length > 0) {
          const f = files[0]
          const url = getImageUrl(f.filename, f.subfolder ?? '', f.type ?? 'output')
          return `${kindLabel} generated: ${f.filename} (prompt: "${prompt}")\n${url}`
        }
      }
      return `${kindLabel} generation completed but no output produced.`
    }
    if (history?.status?.status_str === 'error') {
      // Verbatim ComfyUI error — could be an OOM, a missing node, a bad VAE…
      const msg = history.status.messages?.map((m: any) => m?.[1]?.message).filter(Boolean).join(' | ')
        || history.status.messages?.[0]?.[1]?.message
        || 'Unknown ComfyUI error'
      return `${kindLabel} generation failed: ${msg}`
    }
  }
  const mins = Math.round(timeoutMs / 60000)
  return `${kindLabel} generation timed out after ${mins} minutes.`
}

// ── Small helpers ─────────────────────────────────────────────────

function label(kind: 'image' | 'video'): string {
  return kind === 'video' ? 'Video' : 'Image'
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function clampFloat(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * Turn an `inputImage` argument (a prior generate result's filename, or a /view
 * URL) into a filename inside ComfyUI's *input* folder, ready for LoadImage.
 * Generated images live in ComfyUI's *output* folder, but LoadImage reads from
 * *input* — so we fetch the referenced image and re-upload it via /upload/image.
 */
async function resolveInputImage(ref: string): Promise<string> {
  let url: string
  let name: string
  if (/^https?:\/\//i.test(ref)) {
    url = ref
    const m = ref.match(/[?&]filename=([^&]+)/)
    name = m ? decodeURIComponent(m[1]) : 'lu_input.png'
  } else {
    name = ref.replace(/^.*[\\/]/, '')
    url = getImageUrl(name, '', 'output')
  }
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`could not read input image "${ref}" (HTTP ${resp.status})`)
  const blob = await resp.blob()
  const file = new File([blob], name, { type: blob.type || 'image/png' })
  return await uploadImage(file)
}

function getImageTimeoutMs(): number {
  // ~5 min default per spec; respect the user's imageGenTimeoutMinutes if set.
  try {
    const mins = readSettingNumber('imageGenTimeoutMinutes')
    if (mins && mins > 0) return mins * 60_000
  } catch { /* ignore */ }
  return 5 * 60_000
}

function getVideoTimeoutMs(): number {
  // ~10 min default per spec; respect videoGenTimeoutMinutes if set.
  try {
    const mins = readSettingNumber('videoGenTimeoutMinutes')
    if (mins && mins > 0) return mins * 60_000
  } catch { /* ignore */ }
  return 10 * 60_000
}

function getExclusiveVramMode(): ExclusiveVramMode {
  try {
    const m = useSettingsStore.getState().settings.exclusiveVramMode
    if (m === 'auto' || m === 'always' || m === 'never') return m
  } catch { /* store not available */ }
  return 'auto'
}

function readSettingNumber(key: 'imageGenTimeoutMinutes' | 'videoGenTimeoutMinutes'): number | null {
  try {
    const v = useSettingsStore.getState().settings[key]
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}
