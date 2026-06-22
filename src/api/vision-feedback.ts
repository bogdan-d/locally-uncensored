/**
 * Vision feedback for the chat-agent image/video flow.
 *
 * David's requirement: after the agent generates an image, the chat LLM must
 * actually SEE it and be able to comment — and then optionally turn it into a
 * video. The generation tools (image_generate / video_generate) return a text
 * result with a ComfyUI `/view` URL; that text alone tells a model a file
 * exists but lets it see nothing. This helper turns that result into a real
 * image attachment so a vision-capable model (e.g. gemma4:e4b, which reports
 * the `vision` capability) receives the pixels on its next turn.
 *
 * Gated on the model genuinely supporting vision (Ollama /api/show), so we
 * never ship a useless base64 blob to a text-only model (qwen2.5-coder) or pay
 * the fetch when it can't help.
 */

import { modelSupportsVision } from './ollama'
import { modelNameSuggestsVision } from '../lib/model-compatibility'
import { fetchComfyImageBase64 } from './comfyui'
import { log } from '../lib/logger'

// Same contract as ToolCallBlock's inline preview: only a localhost ComfyUI
// /view URL is trusted (never auto-load arbitrary tool output).
const COMFY_VIEW_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/view\?[^\s)\]]+)/i

function urlIsVideo(url: string): boolean {
  try {
    const m = /[?&]filename=([^&]+)/i.exec(url)
    const name = m ? decodeURIComponent(m[1]) : url
    return /\.(mp4|webm)$/i.test(name)
  } catch {
    return /\.(mp4|webm)(?=[?&]|$)/i.test(url)
  }
}

function filenameFromResult(result: string): string | null {
  // image_generate result shape: `Image generated: <file> (prompt: "...")\n<url>`
  const m = result.match(/generated:\s*([^\s(]+\.(?:png|jpg|jpeg|webp))/i)
  return m ? m[1] : null
}

export interface VisionFeedbackMessage {
  role: 'user'
  content: string
  images: { data: string; mimeType: string }[]
}

/**
 * Build a follow-up user message carrying the just-generated image so the model
 * can look at it. Returns null when this isn't an image result, the model can't
 * see images, or the fetch fails (all non-fatal — the flow still works, the
 * model just won't visually comment).
 */
export async function buildVisionFeedback(
  model: string,
  toolName: string,
  result: string,
  providerId: string,
): Promise<VisionFeedbackMessage | null> {
  if (!result) return null
  // ONLY image_generate produces a still the vision model can read. A video_generate
  // result is ALWAYS a video — not just mp4/webm but also ComfyUI VHS animated .webp /
  // .gif previews, which slip past urlIsVideo's mp4/webm-only check; fed to Ollama as
  // an image they return HTTP 400 "Failed to load image or audio file" (live 2026-06-22:
  // gemma4 + Wan T2V .webp output → spurious post-gen agent error). The call site's own
  // comment already intends to no-op for video results — this makes that real.
  if (toolName !== 'image_generate') return null
  const m = result.match(COMFY_VIEW_RE)
  if (!m) return null
  const url = m[1]
  if (urlIsVideo(url)) return null // can't feed a video to the model as an image
  // Vision capability, provider-aware (konata 2026-06-21: on a non-Ollama
  // provider the generated image never reached the model's vision input, so it
  // described from the prompt and hallucinated). Ollama: the accurate /api/show
  // capability list. Other providers: a STRICT model-name family match — never
  // the lenient isVisionCompatible, which would feed an image to a text-only
  // LM Studio model and trip the image→text SSE error.
  try {
    const canSee = providerId === 'ollama'
      ? await modelSupportsVision(model)
      : modelNameSuggestsVision(model)
    if (!canSee) return null
  } catch {
    return null
  }
  let b64: string
  try {
    b64 = await fetchComfyImageBase64(url)
  } catch (e) {
    log.warn('vision_feedback.fetch_failed', { err: String(e) })
    return null
  }
  if (!b64) return null

  const file = filenameFromResult(result)
  const chain = file
    ? ` If the user asked to turn it into a video, call video_generate now with inputImage set to "${file}".`
    : ' If the user asked to turn it into a video, call video_generate now with inputImage set to that image\'s filename.'

  return {
    role: 'user',
    content:
      'Here is the image you just generated, shown to the user. Look at it and describe in one or two sentences what you actually see in the picture (composition, subject, colors).' +
      chain,
    images: [{ data: b64, mimeType: 'image/png' }],
  }
}
