/* eslint-disable @typescript-eslint/no-explicit-any -- this stub is serialized
   into the browser page and stands in for Tauri's untyped `invoke` bridge; the
   dynamic command args and the `window` globals are `any` by nature. */
/**
 * In-page Tauri bridge mock for the built-in-engine e2e (P3b).
 *
 * Injected with `page.addInitScript` BEFORE the app boots, so
 * `window.__TAURI_INTERNALS__` exists when `isTauri()` (src/api/backend.ts)
 * first runs. Every `invoke()` from `@tauri-apps/api/core` funnels into
 * `__TAURI_INTERNALS__.invoke`, so this router stands in for the whole Rust
 * command surface — no Ollama, no llama-server, no ComfyUI.
 *
 * The interesting part is chat streaming: `proxy_localhost_stream_chunked`
 * receives an `onChunk` Tauri Channel whose `onmessage` the app has already
 * wired to a ReadableStream. We push OpenAI-shaped SSE bytes through it, then
 * an empty chunk (Rust's EOF marker), exactly like the real proxy.
 */

export interface TauriMockOptions {
  /** Assistant text the mocked built-in engine "generates" for the first chat. */
  assistantReply: string
  /** Picker id of the bundled starter model the engine reports as loaded. */
  modelName: string
}

export const DEFAULT_ASSISTANT_REPLY = 'PONG_BUILTIN_OK the built-in engine answered.'
export const DEFAULT_MODEL_NAME = 'qwen2.5-0.5b-instruct-q4_k_m'

/**
 * The function body below is serialized and runs in the PAGE context — it must
 * be fully self-contained (no imports, no outer closure references except the
 * single `opts` argument Playwright forwards).
 */
export function tauriMockInit(opts: TauriMockOptions) {
  const w = window as any
  const MODELS_DIR = '/tmp/lu-e2e/models'
  const modelFile = `${opts.modelName}.gguf`
  const modelPath = `${MODELS_DIR}/${modelFile}`

  // Filenames whose download the app kicked off — reported "complete" on the
  // very next `download_progress` poll so `awaitDownloadComplete` resolves fast.
  const startedDownloads = new Set<string>()

  const enc = (s: string) => Array.from(new TextEncoder().encode(s))

  // Ordered OpenAI SSE for one assistant turn, ending with [DONE].
  function chatSse(text: string): string {
    const frame = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        model: opts.modelName,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    return (
      frame({ role: 'assistant' }, null) +
      frame({ content: text }, null) +
      frame({}, 'stop') +
      'data: [DONE]\n\n'
    )
  }

  function router(cmd: string, args: any): Promise<any> {
    switch (cmd) {
      // ── onboarding / lifecycle markers ────────────────────────────
      case 'is_onboarding_done':
        return Promise.resolve(false)
      case 'set_onboarding_done':
        return Promise.resolve(null)

      // ── model dir + download ──────────────────────────────────────
      case 'detect_model_path':
        return Promise.resolve(MODELS_DIR)
      case 'download_model_to_path': {
        const fn = args?.filename
        if (fn) startedDownloads.add(fn)
        return Promise.resolve({ status: 'started', id: `dl-${fn}` })
      }
      case 'download_progress': {
        const out: Record<string, any> = {}
        for (const fn of startedDownloads) {
          out[fn] = { progress: 1, total: 1, speed: 0, filename: fn, status: 'complete' }
        }
        return Promise.resolve(out)
      }
      case 'pause_download':
      case 'cancel_download':
      case 'resume_download':
        return Promise.resolve(null)

      // ── built-in engine lifecycle (engine.rs surface) ─────────────
      case 'start_bundled_engine':
      case 'swap_bundled_model':
        return Promise.resolve(8127)
      case 'stop_bundled_engine':
        return Promise.resolve(null)
      case 'bundled_engine_status':
        return Promise.resolve({ running: true, healthy: true, port: 8127, model_path: modelPath })
      case 'list_bundled_models':
        return Promise.resolve({
          dir: MODELS_DIR,
          models: [{ name: opts.modelName, path: modelPath, size: 400 * 1024 * 1024, loaded: true }],
        })

      // ── detection: nothing external is running ────────────────────
      case 'get_ollama_host':
        return Promise.resolve('http://localhost:11434')
      case 'lmstudio_model_context':
        // Real Rust returns a shaped object; a null default here trips
        // useActiveContextWindow (`info.loaded`). Return the "unknown" shape.
        return Promise.resolve({ loaded: null, max: null, state: null })
      case 'start_ollama':
      case 'lmstudio_server_status':
      case 'comfyui_status':
      case 'whisper_status':
      case 'install_tts_status':
      case 'search_status':
        return Promise.reject('not running (e2e)')

      // ── chat streaming: drive the onChunk Channel ─────────────────
      case 'proxy_localhost_stream_chunked': {
        const channel = args?.onChunk
        const bytes = enc(chatSse(opts.assistantReply))
        // Deliver on a macrotask so the app's `settled` promise is already
        // being awaited, mirroring the async Rust→WebView channel delivery.
        setTimeout(() => {
          try {
            channel?.onmessage?.(bytes)
            channel?.onmessage?.([]) // empty chunk = EOF marker
          } catch {
            /* reader gone */
          }
        }, 0)
        return Promise.resolve(null)
      }
      case 'proxy_localhost_stream':
        return Promise.resolve(enc(chatSse(opts.assistantReply)))
      case 'cancel_proxy_stream':
        return Promise.resolve(null)

      // ── generic localhost proxy ───────────────────────────────────
      // Ollama's model list (`/api/tags`) must resolve to an EMPTY list so a
      // fresh box looks fresh (existingModelCount === 0 keeps the model picker
      // visible instead of auto-skipping). Resolving here also stops localFetch
      // from falling through to a direct fetch that could hit a REAL Ollama on
      // the dev machine. Every other probe rejects, so no external backend is
      // ever detected as live.
      case 'proxy_localhost': {
        const url: string = args?.url || ''
        if (url.includes('11434') || /\/tags(\?|$)/.test(url)) {
          return Promise.resolve(JSON.stringify({ models: [] }))
        }
        return Promise.reject('error sending request: connection refused (e2e)')
      }

      default:
        // Tauri plugin channels (event listen/unlisten, window, etc.) and any
        // unmodeled command: resolve benignly so nothing throws on boot.
        if (cmd.startsWith('plugin:')) return Promise.resolve(0)
        return Promise.resolve(null)
    }
  }

  let callbackId = 0
  const callbacks: Record<number, (v: any) => void> = {}

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    // Channel/event construction routes through here.
    transformCallback(cb: (v: any) => void) {
      const id = ++callbackId
      callbacks[id] = cb
      w[`_${id}`] = cb
      return id
    },
    unregisterCallback(id: number) {
      delete callbacks[id]
      delete w[`_${id}`]
    },
    convertFileSrc(path: string) {
      return path
    },
    invoke(cmd: string, args: any) {
      return router(cmd, args)
    },
  }
  // Legacy v1 alias some detection code still probes for.
  w.__TAURI__ = w.__TAURI_INTERNALS__
}
