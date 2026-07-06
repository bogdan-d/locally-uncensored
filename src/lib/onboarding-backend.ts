/**
 * Onboarding backend routing (2.5.7).
 *
 * The built-in engine (bundled llama-server, managed lifecycle) is the default
 * backend a fresh install downloads its starter model into. A user who picked a
 * detected backend on the backends step — or who just installed Ollama in-app —
 * overrides that. These pure helpers decide which download/lifecycle path the
 * models step must take, kept out of the component so they can be unit-tested.
 */

export const BUILTIN_BACKEND_ID = 'builtin'

export type OnboardingBackendKind = 'builtin' | 'ollama' | 'openai-compat'

/**
 * Resolve which backend id the model download must feed. `selectedBackend` (set
 * on the backends step, defaults to the built-in engine) wins; the ollamaReady /
 * first-detected fallbacks only matter if it was somehow cleared.
 */
export function resolveOnboardingBackend(
  selectedBackend: string,
  ollamaReady: boolean,
  detectedBackends: { id: string }[],
): string {
  return selectedBackend || (ollamaReady ? 'ollama' : detectedBackends[0]?.id) || BUILTIN_BACKEND_ID
}

/**
 * Classify a backend id into the download/lifecycle path it needs:
 * - `builtin`      → GGUF into the app models dir, then start the bundled engine.
 * - `ollama`       → `ollama pull` (blob/manifest store).
 * - `openai-compat`→ GGUF written into the provider's model dir (LM Studio etc.).
 */
export function classifyOnboardingBackend(backendId: string): OnboardingBackendKind {
  if (backendId === BUILTIN_BACKEND_ID) return 'builtin'
  if (backendId === 'ollama') return 'ollama'
  return 'openai-compat'
}
