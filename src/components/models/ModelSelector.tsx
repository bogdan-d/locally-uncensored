import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Check, Loader2, Power, PlayCircle, X } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useModelStore } from '../../stores/modelStore'
import { useProviderStore } from '../../stores/providerStore'
import { unloadAllModels } from '../../api/ollama'
import { displayModelName } from '../../api/providers'
import { backendCall } from '../../api/backend'
import { listLoadedLmStudioModels, loadLmStudioModel, unloadLmStudioModel } from '../../api/lmstudio'
import { isLmStudioProvider } from '../../lib/hf-to-provider'
import { formatBytes } from '../../lib/formatters'
import type { AIModel } from '../../types/models'

// ── Bug Q (v2.4.7 — wakeywakeynow GH #41) ─────────────────────
//
// Symptom: user has LM Studio installed with models on disk, opens LU's
// chat model picker, sees only Ollama models, no hint about LM Studio.
// Root cause: LM Studio's HTTP server doesn't auto-start with the app —
// the user has to click Developer → Start Server in LM Studio, OR run
// `lms server start`. When the server is off, LU's OpenAI-compat probe
// returns nothing and LM Studio is silently dropped from the dropdown.
// v2.4.4 added a "Start LM Studio server" hint to onboarding, but the
// chat picker (where users actually look for their models) never got
// the same treatment. This banner closes that gap. Polls
// `lmstudio_server_status` on dropdown open; renders inline when LM
// Studio is detected on disk (lms.exe present OR models in
// ~/.lmstudio/models/) AND its server isn't running. Clicking "Start
// Server" hits the same Tauri command the Settings panel uses, then
// re-fetches the model list so the LM Studio models appear without a
// restart.

interface LmStudioServerStatus {
  running: boolean
  port: number
  lms_present: boolean
  models_detected: boolean
  model_count: number
}

// Session-scope dismiss flag. Lives at module-level on purpose: the
// LmStudioServerHint component unmounts when the dropdown closes, so a
// useState reset would resurface the hint on every reopen. Module
// state survives unmount/remount within the same LU run, and resets to
// false when the user relaunches LU (the module reloads from scratch).
// Not persisted to localStorage so a forgotten-to-start server gets
// flagged again next launch.
let LM_HINT_DISMISSED_THIS_SESSION = false

function LmStudioServerHint({ onStarted }: { onStarted: () => void }) {
  const [status, setStatus] = useState<LmStudioServerStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const [dismissed, setDismissed] = useState(LM_HINT_DISMISSED_THIS_SESSION)

  useEffect(() => {
    let cancelled = false
    backendCall<LmStudioServerStatus>('lmstudio_server_status')
      .then(s => { if (!cancelled) setStatus(s) })
      .catch(() => { /* not Tauri / endpoint missing → just don't render */ })
    return () => { cancelled = true }
  }, [])

  // Render only when LM Studio is on disk but its server is off. If
  // running, models are already in the list; if neither lms.exe nor any
  // models are present, the user just doesn't have LM Studio.
  const detected = !!status && (status.lms_present || status.models_detected)
  if (!status || status.running || !detected || dismissed) return null

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (starting) return
    setStarting(true)
    setStartError('')
    try {
      await backendCall('start_lmstudio_server')
      // The CLI takes a second or two to bind 1234 — poll status
      // briefly so the banner replaces itself with the models list
      // instead of leaving the spinner spinning forever.
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 750))
        const fresh = await backendCall<LmStudioServerStatus>('lmstudio_server_status').catch(() => null)
        if (fresh) {
          setStatus(fresh)
          if (fresh.running) {
            onStarted()
            break
          }
        }
      }
    } catch (e: any) {
      setStartError(e?.message ? String(e.message).slice(0, 80) : 'Start failed')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="relative px-2.5 py-2 border-b border-white/[0.04] bg-white/[0.03]">
      <button
        onClick={(e) => { e.stopPropagation(); LM_HINT_DISMISSED_THIS_SESSION = true; setDismissed(true) }}
        aria-label="Dismiss (returns on next launch)"
        title="Dismiss (returns on next launch)"
        className="absolute top-1 right-1 p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-white/[0.08] transition-colors"
      >
        <X size={10} />
      </button>
      <p className="text-[0.6rem] text-gray-300 leading-snug mb-1.5 pr-5">
        LM Studio is installed ({status.model_count} model{status.model_count === 1 ? '' : 's'} on disk) but its server isn't running. Start it to pick LM Studio models here.
      </p>
      <button
        onClick={handleStart}
        disabled={starting}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded text-[0.62rem] bg-white/[0.06] hover:bg-white/[0.12] text-gray-200 transition-colors disabled:opacity-50"
      >
        {starting ? <Loader2 size={10} className="animate-spin" /> : <PlayCircle size={10} />}
        <span>{starting ? 'Starting LM Studio server…' : 'Start LM Studio Server'}</span>
      </button>
      {startError && (
        <p className="text-[0.55rem] text-red-300/70 mt-1 leading-snug">{startError}</p>
      )}
    </div>
  )
}

// ── Badge configs ─────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  text: 'text-blue-400',
  image: 'text-purple-400',
  video: 'text-emerald-400',
}

const TYPE_LABEL: Record<string, string> = {
  text: 'TXT',
  image: 'IMG',
  video: 'VID',
}

const PROVIDER_BADGE: Record<string, { label: string; color: string }> = {
  ollama: { label: 'Ollama', color: 'text-emerald-400/70' },
  openai: { label: 'Cloud', color: 'text-sky-400/70' },
  anthropic: { label: 'Claude', color: 'text-violet-400/70' },
}

function getProviderBadge(model: AIModel) {
  const provider = ('provider' in model && model.provider) || 'ollama'
  const providerName = ('providerName' in model && model.providerName) || 'Ollama'

  if (providerName && providerName !== 'Ollama' && providerName !== 'OpenAI-Compatible' && providerName !== 'Anthropic') {
    return { label: providerName, color: PROVIDER_BADGE[provider]?.color || PROVIDER_BADGE.ollama.color }
  }
  return PROVIDER_BADGE[provider] || PROVIDER_BADGE.ollama
}

// ── Group models by family (Qwen / Gemma / Llama / …) ────────
//
// Users care more about model lineage than about which local backend
// they're pointing at. "Qwen 3.6 27B" appears once under Qwen whether
// it came from Ollama or LM Studio — the per-row provider badge
// (rendered below) keeps that detail visible.
//
// Pure visual grouping — model name + provider still resolve chat
// routing exactly as before.

// Normalize a model name into a comparable base form:
//   openai::qwen3.6-27b        → qwen3.6-27b
//   richardyoung/qwen3-14b:…   → qwen3-14b
//   Qwen3.6-27B-Q4_K_M.gguf    → qwen3.6-27b-q4_k_m.gguf
function normalizeModelName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/^[^:]+::/, '')    // strip openai:: / anthropic::
    .replace(/^[^/]+\//, '')    // strip repo-author/ prefix
    .replace(/:.+$/, '')        // strip :tag suffix
}

// Ordered — first match wins. Prefixes/infixes on the normalized name.
const FAMILY_MATCHERS: Array<{ family: string; test: RegExp }> = [
  { family: 'Qwen',       test: /^qwen|^qwq/ },
  { family: 'Gemma',      test: /^gemma/ },
  { family: 'Llama',      test: /^llama|^meta[-_]?llama/ },
  { family: 'Mistral',    test: /^mistral|^mixtral|^mistral-nemo|^mistral-small|^mistral-large/ },
  { family: 'DeepSeek',   test: /^deepseek/ },
  { family: 'Phi',        test: /^phi-?\d|^phi_?\d/ },
  { family: 'Hermes',     test: /^hermes|^nous-/ },
  { family: 'Dolphin',    test: /^dolphin/ },
  { family: 'Claude',     test: /^claude/ },
  { family: 'GPT-OSS',    test: /^gpt-oss/ },
  { family: 'GPT / o-series', test: /^gpt-|^o1-|^o3-/ },
  { family: 'Command',    test: /^command/ },
  { family: 'GLM',        test: /^glm|^chatglm|^zai/ },
  { family: 'Yi',         test: /^yi-/ },
  { family: 'Gemini',     test: /^gemini/ },
  { family: 'Grok',       test: /^grok/ },
]

function getModelFamily(modelName: string): string {
  const n = normalizeModelName(modelName)
  for (const { family, test } of FAMILY_MATCHERS) {
    if (test.test(n)) return family
  }
  return 'Other'
}

// Family display order — Qwen/Gemma/Llama surface first since they're
// the most common local-chat picks; cloud-only families (Claude/GPT)
// come after the local ones; 'Other' always last.
const FAMILY_ORDER: string[] = [
  'Qwen', 'Gemma', 'Llama', 'Mistral', 'DeepSeek', 'Phi', 'Hermes',
  'Dolphin', 'GLM', 'GPT-OSS', 'Yi', 'Command',
  'Claude', 'GPT / o-series', 'Gemini', 'Grok',
]

function groupByFamily(models: AIModel[]): { family: string; models: AIModel[] }[] {
  const groups: Record<string, AIModel[]> = {}
  for (const m of models) {
    const fam = getModelFamily(m.name)
    if (!groups[fam]) groups[fam] = []
    groups[fam].push(m)
  }

  return Object.entries(groups)
    .sort(([a], [b]) => {
      if (a === 'Other') return 1
      if (b === 'Other') return -1
      const ai = FAMILY_ORDER.indexOf(a)
      const bi = FAMILY_ORDER.indexOf(b)
      if (ai >= 0 && bi >= 0) return ai - bi
      if (ai >= 0) return -1
      if (bi >= 0) return 1
      return a.localeCompare(b)
    })
    .map(([family, models]) => ({ family, models }))
}

// ── LM Studio selection helpers (§18) ─────────────────────────
//
// Extracted as pure module-level functions so the select-time auto-load
// decision is unit-testable without rendering the whole hook-heavy
// component (no test harness exists for ModelSelector — it depends on
// several zustand stores + the Tauri bridge).

/**
 * The identifier LM Studio's CLI/bridge uses for `model` — its `lmsKey`
 * when present (the exact key the loaded-list reports), else the model name.
 * Centralised so the row toggle, the loaded check, and the select-time
 * auto-load all agree on one id.
 *
 * CRITICAL: strip LU's routing prefix. An LM Studio model's `name` carries the
 * provider-scoped form "openai::qwen2.5-0.5b-instruct@q4_k_m" (getProviderForModel
 * routes on that `openai::`), but the `lms` CLI and LM Studio's /api/v0/models use
 * the BARE key "qwen2.5-0.5b-instruct@q4_k_m". Passing the prefixed name to
 * `lms load` matches nothing — pre-`-y` it dropped into the interactive picker and
 * the command hung forever (stuck "loading…" spinner, no error); post-`-y` it
 * exits 1. The loaded-check `loaded.has(lmsIdOf(...))` also silently failed
 * (bare keys from the API vs. a prefixed id), so rows showed perpetually unloaded
 * and selecting re-triggered a load every time. Same `/^[^:]+::/` strip as
 * displayModelName. (Found via live E2E 2026-06-01.)
 */
export function lmsIdOf(model: AIModel): string {
  const raw = ('lmsKey' in model && typeof (model as any).lmsKey === 'string'
    ? (model as any).lmsKey
    : model.name) as string
  return raw.replace(/^[^:]+::/, '')
}

/**
 * True when selecting `model` must auto-load it into LM Studio first: it's
 * an LM Studio model AND it isn't already in the loaded set. Non-LM-Studio
 * models (Ollama, cloud) always return false — they activate immediately.
 */
export function shouldAutoLoadForSelect(
  model: AIModel,
  loaded: Set<string>,
): boolean {
  const isLms = isLmStudioProvider(
    ('providerName' in model && model.providerName) as string | undefined,
  )
  return isLms && !loaded.has(lmsIdOf(model))
}

// ── Component ─────────────────────────────────────────────────

export function ModelSelector() {
  const { models, activeModel, setActiveModel, fetchModels } = useModels()
  const isModelLoading = useModelStore((s) => s.isModelLoading)
  const [open, setOpen] = useState(false)
  const [unloading, setUnloading] = useState(false)
  const [unloadDone, setUnloadDone] = useState(false)
  // B3 — per-model LM Studio load/unload state. `lmsLoaded` is the set
  // of LM Studio model identifiers currently loaded in the server;
  // `togglingLms` is the one we're flipping right now (drives the
  // spinner on the row). LM Studio's HTTP server doesn't have load /
  // unload endpoints, so we route through the `lms` CLI via the
  // bridge's `lmstudio_load_model` / `lmstudio_unload_model` commands.
  const [lmsLoaded, setLmsLoaded] = useState<Set<string>>(new Set())
  const [togglingLms, setTogglingLms] = useState<string | null>(null)
  // B3/§18 — the LM Studio model we're auto-loading as part of *selecting* it
  // (distinct from `togglingLms`, the explicit power-button flow). Drives the
  // inline "loading…" state on the row and blocks a second click.
  const [selectingLms, setSelectingLms] = useState<string | null>(null)
  const [selectError, setSelectError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // Refresh LM Studio loaded-models snapshot whenever the dropdown
  // opens. Cheap — single HTTP call. We don't poll while the dropdown
  // is open because the user is about to click something anyway and
  // staleness is at most a few seconds.
  useEffect(() => {
    if (!open) return
    setSelectError(null) // fresh open — drop any stale auto-load error
    let cancelled = false
    void listLoadedLmStudioModels().then((list) => {
      if (cancelled) return
      setLmsLoaded(new Set(list))
    })
    return () => {
      cancelled = true
    }
  }, [open])

  /**
   * Flip a LM Studio model between loaded / unloaded via the bridge.
   * Refreshes the loaded set on success so the toggle reflects reality
   * (the user might have multiple LM Studio models loaded already).
   */
  const toggleLmStudioLoad = async (model: AIModel) => {
    const id = ('lmsKey' in model && typeof (model as any).lmsKey === 'string'
      ? (model as any).lmsKey
      : model.name) as string
    if (!id || togglingLms) return
    setTogglingLms(id)
    try {
      if (lmsLoaded.has(id)) {
        await unloadLmStudioModel(id)
      } else {
        await loadLmStudioModel(id)
      }
      const list = await listLoadedLmStudioModels()
      setLmsLoaded(new Set(list))
    } catch {
      // Best-effort: leave the previous snapshot in place; the user
      // can re-open the dropdown to retry.
    } finally {
      setTogglingLms(null)
    }
  }

  /**
   * §18 — Select a model, auto-loading it into LM Studio first when needed.
   *
   * Routing (getProviderForModel) keys only on the `openai::` prefix, so an
   * LM Studio model's HTTP requests go out regardless of whether the model
   * is actually loaded in the server — picking an UNloaded one used to fail
   * silently at the HTTP layer (404 from LM Studio). So: if the picked row is
   * an LM Studio model that isn't loaded, load it (await) BEFORE activating,
   * showing an inline "loading…" state; only then setActiveModel + close. On
   * load failure we keep the dropdown open and surface the error instead of
   * activating a model that can't answer. Non-LM-Studio rows are unaffected —
   * they activate immediately exactly as before.
   */
  const handleSelectModel = async (model: AIModel) => {
    const id = lmsIdOf(model)

    if (shouldAutoLoadForSelect(model, lmsLoaded)) {
      if (selectingLms || togglingLms) return // a load is already in flight
      setSelectError(null)
      setSelectingLms(id)
      try {
        await loadLmStudioModel(id)
        // Confirm it actually loaded before we route chat at it.
        const list = await listLoadedLmStudioModels()
        const loaded = new Set(list)
        setLmsLoaded(loaded)
        if (!loaded.has(id)) {
          setSelectError(`Couldn't load "${displayModelName(model.name)}" into LM Studio. Try the power button, or load it in LM Studio directly.`)
          return // keep dropdown open; don't activate an unloaded model
        }
        setActiveModel(model.name)
        setOpen(false)
      } catch {
        setSelectError(`Couldn't load "${displayModelName(model.name)}" into LM Studio. Is the LM Studio server running?`)
      } finally {
        setSelectingLms(null)
      }
      return
    }

    // Non-LM-Studio, or an already-loaded LM Studio model: activate now.
    setActiveModel(model.name)
    setOpen(false)
  }

  useEffect(() => { fetchModels() }, [fetchModels])

  // Refetch when any provider's enabled state or baseUrl changes (e.g. user
  // enables LM Studio / adds Anthropic key in Settings, or the backend
  // picker activates an OpenAI-compatible provider). Without this the
  // dropdown stays stuck on whatever providers were enabled at mount time.
  useEffect(() => {
    const unsub = useProviderStore.subscribe((state, prev) => {
      const changed = (Object.keys(state.providers) as Array<keyof typeof state.providers>)
        .some(id => state.providers[id]?.enabled !== prev.providers[id]?.enabled
          || state.providers[id]?.baseUrl !== prev.providers[id]?.baseUrl)
      if (changed) fetchModels()
    })
    return () => unsub()
  }, [fetchModels])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const activeDisplayName = activeModel ? displayModelName(activeModel).split(':')[0] : 'Select Model'
  const activeModelObj = models.find((m) => m.name === activeModel)
  const activeType = activeModelObj?.type || 'text'
  // Chat dropdown shows TEXT models only — image/video live in the
  // Create view's own picker. Everything here is grouped by the model
  // FAMILY (Qwen/Gemma/Llama/…), not by provider, because users pick
  // models by lineage first and the backend that serves them is a
  // per-row badge.
  const textModels = models.filter(m => m.type === 'text')
  const groups = groupByFamily(textModels)
  const hasOllamaModels = textModels.some(m => ('provider' in m && m.provider === 'ollama') || !('provider' in m))

  return (
    <div ref={ref} className="relative">
      {/* ── Trigger Button ── */}
      <button
        onClick={() => setOpen(!open)}
        className={`
          group flex items-center gap-1.5 h-[26px] px-2 rounded-md
          bg-transparent border transition-all text-[0.7rem]
          hover:bg-white/[0.04]
          ${isModelLoading
            ? 'border-blue-500/40 shadow-[0_0_6px_rgba(59,130,246,0.2)]'
            : 'border-white/[0.06] hover:border-white/[0.1]'
          }
        `}
      >
        {/* Type indicator dot */}
        <span className={`w-1.5 h-1.5 rounded-full ${
          activeType === 'text' ? 'bg-blue-400' : activeType === 'image' ? 'bg-purple-400' : 'bg-emerald-400'
        } ${isModelLoading ? 'animate-pulse' : ''}`} />

        {/* Model name */}
        <span className="text-gray-300 max-w-[140px] truncate leading-none">
          {activeDisplayName}
        </span>

        {/* Chevron / Spinner */}
        {isModelLoading ? (
          <Loader2 size={10} className="animate-spin text-blue-400 ml-0.5" />
        ) : (
          <ChevronDown size={10} className={`text-gray-500 transition-transform ml-0.5 ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {/* ── Dropdown ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute top-full mt-1.5 left-1/2 -translate-x-1/2 w-72 rounded-lg overflow-hidden z-50 bg-[#363636] border border-white/[0.08] shadow-2xl shadow-black/50"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
          >
            {/* Bug Q v2.4.7 — surface "Start LM Studio Server" inline when
                LM Studio is on disk but its server is off. wakeywakeynow's
                "can't choose any models i have installed" symptom. */}
            <LmStudioServerHint onStarted={fetchModels} />

            {/* §18 — surfaced when an LM Studio auto-load (on select) failed,
                so the user isn't left wondering why the model didn't switch. */}
            {selectError && (
              <div className="mx-2 mt-2 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-[0.6rem] text-red-300/90 leading-snug">
                {selectError}
              </div>
            )}

            {/* Scrollable model list */}
            <div className="py-1 max-h-[280px] overflow-y-auto scrollbar-thin">
              {textModels.length === 0 && (
                <p className="text-[0.65rem] text-gray-600 text-center py-3">No models available</p>
              )}

              {groups.map(({ family, models: groupModels }) => (
                <div key={family}>
                  {/* Section header */}
                  {groups.length > 1 && (
                    <div className="px-2.5 pt-2 pb-0.5">
                      <span className="text-[0.55rem] font-medium uppercase tracking-widest text-gray-600">
                        {family}
                      </span>
                    </div>
                  )}

                  {groupModels.map((model: AIModel) => {
                    const modelDisplayName = displayModelName(model.name)
                    const modelProvider = ('provider' in model && model.provider) || 'ollama'
                    const providerBadge = getProviderBadge(model)
                    const isActive = model.name === activeModel

                    const isLmsRow = isLmStudioProvider(('providerName' in model && model.providerName) as string | undefined)
                    const rowId = lmsIdOf(model)
                    const isSelectingThis = selectingLms === rowId
                    // The row carries the per-LM-Studio-model power toggle, itself
                    // a <button>. A <button> can't nest a <button> (invalid HTML →
                    // React hydration error + flaky clicks), so the row is a
                    // role="button" <div> with explicit keyboard activation.
                    const rowDisabled = selectingLms !== null || togglingLms !== null

                    return (
                      <div
                        key={model.name}
                        role="button"
                        tabIndex={rowDisabled ? -1 : 0}
                        aria-disabled={rowDisabled}
                        onClick={() => { if (!rowDisabled) void handleSelectModel(model) }}
                        onKeyDown={(e) => {
                          if (rowDisabled) return
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            void handleSelectModel(model)
                          }
                        }}
                        className={`
                          w-full flex items-center gap-2 px-2.5 py-[5px] mx-1 rounded text-left transition-colors
                          ${isActive
                            ? 'bg-white/[0.06] text-white'
                            : 'text-gray-400 hover:bg-white/[0.03] hover:text-gray-200'
                          }
                          ${rowDisabled ? 'cursor-default' : 'cursor-pointer'}
                        `}
                        style={{ width: 'calc(100% - 8px)' }}
                      >
                        {/* Type dot */}
                        <span className={`w-1 h-1 rounded-full shrink-0 ${
                          model.type === 'text' ? 'bg-blue-400/70' : model.type === 'image' ? 'bg-purple-400/70' : 'bg-emerald-400/70'
                        }`} />

                        {/* Model info */}
                        <div className="flex-1 min-w-0 flex items-center gap-1.5">
                          <span className={`text-[0.7rem] truncate ${isActive ? 'text-white' : ''}`}>
                            {modelDisplayName}
                          </span>

                          {/* Subtle meta */}
                          {model.type !== 'text' && (
                            <span className={`text-[8px] uppercase font-medium tracking-wide ${TYPE_COLOR[model.type] || 'text-gray-500'} opacity-60`}>
                              {TYPE_LABEL[model.type] || model.type}
                            </span>
                          )}
                          {modelProvider !== 'ollama' && (
                            <span className={`text-[8px] ${providerBadge.color}`}>
                              {providerBadge.label}
                            </span>
                          )}
                          {/* §18 — inline load state while we auto-load this
                              LM Studio model on the way to selecting it. */}
                          {isSelectingThis && (
                            <span className="inline-flex items-center gap-0.5 text-[8px] text-blue-400">
                              <Loader2 size={8} className="animate-spin" />
                              loading…
                            </span>
                          )}
                        </div>

                        {/* Details on right */}
                        <div className="flex items-center gap-1 shrink-0">
                          {model.type === 'text' && 'details' in model && (model as any).details && (
                            <span className="text-[8px] text-gray-600">
                              {(model as any).details.parameter_size}
                            </span>
                          )}
                          {/* B3/§18 — LM Studio per-row power toggle. Selecting
                              an LM Studio row now AUTO-LOADS it first (see
                              handleSelectModel), so this button is the explicit
                              control: load without selecting, or UNLOAD to free
                              VRAM. Click stops propagation so the row's
                              select-handler doesn't also fire. Ollama rows load
                              implicitly when chat fires, so they get no button. */}
                          {isLmsRow && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                void toggleLmStudioLoad(model)
                              }}
                              disabled={togglingLms !== null || selectingLms !== null}
                              title={
                                lmsLoaded.has(rowId)
                                  ? 'Loaded — click to unload from LM Studio (frees VRAM)'
                                  : 'Load into LM Studio without selecting (selecting also loads automatically)'
                              }
                              className={`p-0.5 rounded transition-colors ${
                                lmsLoaded.has(rowId)
                                  ? 'text-emerald-500 hover:bg-emerald-500/10'
                                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]'
                              } disabled:opacity-40`}
                            >
                              {togglingLms === rowId ? (
                                <Loader2 size={10} className="animate-spin" />
                              ) : (
                                <Power size={10} />
                              )}
                            </button>
                          )}
                          {isActive && <Check size={11} className="text-blue-400" />}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>

            {/* Sticky footer: Unload */}
            {hasOllamaModels && (
              <div className="border-t border-white/[0.04] px-1 py-1">
                <button
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (unloading) return
                    setUnloading(true)
                    setUnloadDone(false)
                    try {
                      await unloadAllModels()
                      setUnloadDone(true)
                      setTimeout(() => setUnloadDone(false), 2000)
                    } catch { /* ignore */ }
                    finally { setUnloading(false) }
                  }}
                  disabled={unloading}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-[5px] rounded text-[0.6rem] text-red-500/60 hover:text-red-400 hover:bg-red-500/[0.06] transition-colors disabled:opacity-40"
                >
                  {unloading ? <Loader2 size={10} className="animate-spin" /> : <Power size={10} />}
                  <span>{unloadDone ? 'Unloaded' : unloading ? 'Unloading...' : 'Unload all models'}</span>
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
