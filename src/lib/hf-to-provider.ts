/**
 * HuggingFace GGUF URL → provider-specific reference / target path.
 *
 * Why this exists:
 *
 * Ollama and LM Studio both consume GGUFs but expect very different layouts.
 * Ollama owns its model directory (blob store + manifests) and ignores any
 * raw .gguf you drop into ~/.ollama/models. The only sound way to get a HF
 * GGUF into Ollama is to call /api/pull with `hf.co/<user>/<repo>:<quant>`,
 * which Ollama then materialises into its own store.
 *
 * LM Studio scans the model dir for `<user>/<repo>/<file>.gguf` — flat .gguf
 * files at the top level of the model dir are ignored.
 *
 * The previous behaviour was: download the raw .gguf into the provider dir
 * and hope. For both providers above, that "hope" never resolves and the
 * model never appears in the model list — the bug from Discord/GitHub.
 */

const HF_HOST_RE = /^https?:\/\/(?:huggingface\.co|hf\.co)\/([^\/]+)\/([^\/]+)\/(?:resolve|raw|blob)\/[^\/]+\/(.+)$/i

export interface HfRef {
  user: string
  repo: string
  filename: string
}

export function parseHfUrl(url: string): HfRef | null {
  const m = url.match(HF_HOST_RE)
  if (!m) return null
  return { user: m[1], repo: m[2], filename: m[3] }
}

/**
 * Extract the quantisation tag from a GGUF filename.
 *
 * Recognises the formats bartowski / mradermacher / unsloth / QuantFactory
 * actually ship: Q\d_K_[MSL], IQ\d_[A-Z0-9_]+, Q\d_0, Q\d_1, F16, BF16, F32.
 *
 * Returns undefined if no recognised quant is found — callers should fall
 * back to letting Ollama auto-pick (it defaults to Q4_K_M when no tag is
 * given on `hf.co/<repo>` references).
 */
export function extractGgufQuant(filename: string): string | undefined {
  const m = filename.match(
    /[-._](Q\d_K_[MSL]|Q\d_[01]|IQ\d_[A-Z0-9_]+|F16|BF16|F32)\.gguf$/i
  )
  return m?.[1].toUpperCase()
}

/**
 * Build the Ollama HF reference for a HuggingFace GGUF download URL.
 *
 * Returns e.g. "hf.co/bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M".
 * Falls back to no quant tag (Ollama then auto-selects) when the filename
 * doesn't match a known quant pattern.
 *
 * Returns null for non-HF URLs — callers should treat that as "this URL
 * cannot go through ollama pull, use direct download".
 */
export function hfUrlToOllamaRef(url: string, filename?: string): string | null {
  const parsed = parseHfUrl(url)
  if (!parsed) return null
  const quant = extractGgufQuant(filename || parsed.filename)
  const base = `hf.co/${parsed.user}/${parsed.repo}`
  return quant ? `${base}:${quant}` : base
}

/**
 * Build the publisher/repo subfolder LM Studio expects for a HF GGUF.
 *
 * Returns e.g. "bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF".
 * The full destination becomes `<lmstudio_models_dir>/<this>/<filename>.gguf`,
 * which is the layout LM Studio's scanner uses (mirrors the HF repo path).
 */
export function hfUrlToLmStudioSubdir(url: string): string | null {
  const parsed = parseHfUrl(url)
  if (!parsed) return null
  return `${parsed.user}/${parsed.repo}`
}

/**
 * The list of provider IDs whose downloads must go through ollama pull
 * rather than a direct file write.
 */
export function isOllamaProvider(providerName: string | undefined | null): boolean {
  if (!providerName) return false
  const lower = providerName.toLowerCase()
  return lower === 'ollama'
}

/**
 * The list of provider IDs whose downloads expect the LM-Studio-style
 * <user>/<repo>/<file>.gguf nesting.
 */
export function isLmStudioProvider(providerName: string | undefined | null): boolean {
  if (!providerName) return false
  const lower = providerName.toLowerCase()
  return lower === 'lm studio' || lower === 'lmstudio'
}
