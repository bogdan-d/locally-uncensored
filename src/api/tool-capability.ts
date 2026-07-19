/**
 * 2.5.8 — per-model tool-calling (function-calling) capability cache.
 *
 * The LU Cloud inference catalog does not expose which hosted models support
 * function calling, and local backends vary by model, so LU optimistically
 * sends `tools` and lets the provider decide. When a tool-augmented request is
 * rejected for the tools themselves (DeepInfra / LU Cloud returns HTTP 405,
 * Ollama returns a "does not support tools" error), the UI catch site records
 * that model here as tools-unsupported so:
 *   - the chat model dropdown can flag it with a small marker, and
 *   - a later Agent / Code run can warn before wasting another request.
 *
 * Mirrors `agents/format-capability.ts`: localStorage-backed, negative results
 * expire after a day so a re-quantised model or an upgraded server deployment
 * recovers on its own without a manual cache clear. No active probe — tool
 * support is learned from real request outcomes, never a synthetic call.
 */

const STORAGE_KEY = 'lu-tool-capability-v1'
/** How long a cached negative result is trusted before we re-try the model. */
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000

export type ToolCapability = 'supported' | 'unsupported' | 'unknown'

type CacheEntry = {
  capability: 'supported' | 'unsupported'
  checkedAt: number
}

type CacheShape = Record<string, CacheEntry>

/**
 * Strip LU's `provider::` routing prefix so a lookup converges whether the
 * caller passes the raw id sent to the provider (hooks) or the picker's
 * `model.name` (which may carry the prefix). Keeps cloud + local keys aligned.
 */
function keyOf(model: string): string {
  const i = model.lastIndexOf('::')
  return i >= 0 ? model.slice(i + 2) : model
}

function loadCache(): CacheShape {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveCache(cache: CacheShape): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Quota errors etc. — swallowed; capability is re-learned next run.
  }
}

/**
 * Cached tool-calling capability for a model. 'unknown' means we have never
 * seen a tool request resolve either way, so callers should still try (and
 * not block). Negative results older than NEGATIVE_TTL_MS decay to 'unknown'.
 */
export function getToolCapability(model: string): ToolCapability {
  if (!model) return 'unknown'
  const entry = loadCache()[keyOf(model)]
  if (!entry) return 'unknown'
  if (entry.capability === 'supported') return 'supported'
  if (Date.now() - entry.checkedAt > NEGATIVE_TTL_MS) return 'unknown'
  return 'unsupported'
}

/** Mark a model as supporting tool calling (a tool call actually landed). Sticky. */
export function markToolsSupported(model: string): void {
  if (!model) return
  const cache = loadCache()
  cache[keyOf(model)] = { capability: 'supported', checkedAt: Date.now() }
  saveCache(cache)
}

/** Mark a model as NOT supporting tool calling. Expires after NEGATIVE_TTL_MS. */
export function markToolsUnsupported(model: string): void {
  if (!model) return
  const cache = loadCache()
  cache[keyOf(model)] = { capability: 'unsupported', checkedAt: Date.now() }
  saveCache(cache)
}

/** Drop the cache entry for a model (forces a fresh attempt next use). */
export function clearToolCapability(model: string): void {
  const cache = loadCache()
  delete cache[keyOf(model)]
  saveCache(cache)
}

/** Debug / test helper — wipe the entire cache. */
export function resetToolCapabilityCache(): void {
  saveCache({})
}
