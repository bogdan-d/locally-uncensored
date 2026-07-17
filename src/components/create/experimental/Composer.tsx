import { useCallback, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, X, History, SlidersHorizontal, Square } from 'lucide-react'
import { useCreateStore, MODEL_TYPE_DEFAULTS, type CreateIntent } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { intentToJob } from '../../../lib/render/cloud-jobs'
import {
  cloudModelById,
  defaultCloudModel,
  defaultEditModel,
  isEditCapable,
  modelForOp,
  runCredits,
} from '../../../stores/cloudCatalogStore'
import { INTENT_MAP } from './intents'
import { ModelChip } from './ModelChip'
import { SpecialControls } from './SpecialIntentControls'
import { CreditsMeter } from './CreditsMeter'
import { Button } from '../ui/Button'
import { PromptField } from '../ui/PromptField'
import { Segmented } from '../ui/Segmented'
import { Slider } from '../ui/Slider'
import { Tooltip } from '../ui/Tooltip'
import { cn } from '../ui/cn'
import { useClickAway } from '../ui/useClickAway'

interface Props {
  onOpenAdvanced: () => void
}

export function Composer({ onOpenAdvanced }: Props) {
  const intent = useCreateStore((s) => s.intent())
  const meta = INTENT_MAP[intent]
  const prompt = useCreateStore((s) => s.prompt)
  const setPrompt = useCreateStore((s) => s.setPrompt)
  const negativePrompt = useCreateStore((s) => s.negativePrompt)
  const setNegativePrompt = useCreateStore((s) => s.setNegativePrompt)
  const showNegative = useCreateStore((s) => s.showNegative)
  const toggleNegative = useCreateStore((s) => s.toggleNegative)
  const source = useCreateStore((s) => s.source)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const backend = useCreateStore((s) => s.backend)
  const targetResolution = useCreateStore((s) => s.targetResolution)
  const setTargetResolution = useCreateStore((s) => s.setTargetResolution)
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const frames = useCreateStore((s) => s.frames)
  const fps = useCreateStore((s) => s.fps)
  // 2.5.8 specialized-intent inputs (readiness for the Create button).
  const characterTab = useCreateStore((s) => s.characterTab)
  const trainImages = useCreateStore((s) => s.trainImages)
  const selectedCharacter = useCreateStore((s) => s.selectedCharacter)
  const audioInput = useCreateStore((s) => s.audioInput)
  const voiceFromJob = useCreateStore((s) => s.voiceFromJob)
  const videoInput = useCreateStore((s) => s.videoInput)
  const extendSource = useCreateStore((s) => s.extendSource)
  const musicDuration = useCreateStore((s) => s.musicDuration)
  const { generate, cancel, quota } = useCreateExp()

  // The Create button turns into Cancel in place — a double-click's second
  // press would instantly cancel the run it just started. Ignore cancel
  // presses in the first 400ms after starting.
  const startedAt = useRef(0)
  const guardedGenerate = useCallback(() => {
    startedAt.current = Date.now()
    generate()
  }, [generate])
  const guardedCancel = useCallback(() => {
    if (Date.now() - startedAt.current < 400) return
    cancel()
  }, [cancel])

  // Single-purpose endpoints (cutout/upscale/eraser): no prompt, no
  // generation knobs, no model choice — just the input (+ mask/resolution).
  const isUtility = meta.id === 'removebg' || meta.id === 'upscale' || meta.id === 'eraser'
  // 2.5.8 categories with their own composer surfaces + input contracts.
  const special =
    intent === 'character' || intent === 'lipsync' || intent === 'music' ||
    intent === 'extend' || intent === 'motion'
  const characterUse = intent === 'character' && characterTab === 'use'
  let { kind: intentKind, op: intentOp } = intentToJob(intent)
  if (characterUse) {
    // The use-surface is a plain image generate with the character attached.
    intentKind = 'image'
    intentOp = 'generate'
  }
  // The prompt field shows wherever the run consumes one — that's the meta
  // flag, plus Character-Studio's use-surface (train has no prompt).
  const needPrompt = meta.needsPrompt || characterUse
  // Gate on the exact run's cost (model + op + clip length), the same figure
  // the CreditsMeter shows — quota.costs[kind] is only the tier's
  // representative per-kind number and would mis-gate utility ops / pricier
  // models.
  const pickedModel = characterUse
    ? 'flux-schnell-lora'
    : special
      ? cloudOpModel
      : (intentKind === 'video' ? cloudVideoModel : cloudImageModel) ||
        defaultCloudModel(intentKind)?.id || ''
  const runSeconds =
    intentOp === 'music'
      ? musicDuration
      : intentKind === 'video' && (intentOp === 'generate' || intentOp === 'animate') && fps > 0
        ? frames / fps
        : undefined
  const costFallback = quota?.costs[intentKind === 'audio' ? 'image' : intentKind] ?? 0
  const creditsOk =
    backend !== 'cloud' ||
    (quota != null &&
      quota.remaining.credits >=
        runCredits(intentKind, intentOp, pickedModel, runSeconds, costFallback, targetResolution))
  // Match useCloudCreate's submit-time edit fallback so the Neg gate reflects
  // the model the run actually uses, not a t2i model still in the picker.
  const runModel =
    intentOp === 'edit' && !isEditCapable(pickedModel) ? (defaultEditModel()?.id ?? pickedModel) : pickedModel
  // The hosted endpoints only honour negative_prompt for a few families —
  // hide the toggle (and the collapsed field) where it would be silently
  // dropped, like the other dead knobs on cloud.
  const negSupported = backend !== 'cloud' || cloudModelById(runModel)?.negative_prompt === true
  // Per-intent readiness for the 2.5.8 categories (mirrors useCloudCreate's
  // submit-time checks so the button never invites a doomed run).
  const lipsyncNeedsClip =
    intent === 'lipsync' &&
    cloudModelById(modelForOp('video', 'lipsync', cloudOpModel))?.lipsync_source === 'video'
  const specialReady =
    intent === 'character'
      ? (characterUse ? !!selectedCharacter : trainImages.length >= 4)
      : intent === 'lipsync'
        ? (!!audioInput || !!voiceFromJob) && (lipsyncNeedsClip ? !!videoInput : !!source)
        : intent === 'extend'
          ? !!extendSource
          : intent === 'motion'
            ? !!source && !!videoInput
            : true
  const canGenerate =
    (!needPrompt || prompt.trim().length > 0) &&
    (!meta.needsSource || !!source) &&
    specialReady &&
    creditsOk

  return (
    // A stable min-height (bottom-anchored) so the prompt window occupies the
    // same vertical space on every tab — utility modes (no QuickControls / no
    // prompt) don't shrink it. That keeps the viewer + gallery row above it the
    // exact SAME height across all tabs, not just within one.
    <div className="shrink-0 px-4 pb-4 pt-2 min-h-[192px] flex flex-col justify-end">
      <div className="mx-auto w-full max-w-[760px] space-y-2.5">
        {!isUtility && !special && <QuickControls />}
        {special && <SpecialControls intent={intent} />}

        <div className="rounded-[var(--radius-panel)] bg-white/[0.03] border border-white/[0.06] focus-within:border-white/15 transition-colors">
          {needPrompt && (
            <div className="px-3.5 pt-3">
              <PromptField
                value={prompt}
                onChange={setPrompt}
                placeholder={characterUse ? 'Describe the scene for your character…' : meta.placeholder}
                onSubmit={() => canGenerate && !isGenerating && guardedGenerate()}
              />
            </div>
          )}

          <AnimatePresence>
            {showNegative && needPrompt && negSupported && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="mx-3.5 mt-2 pt-2 border-t border-white/[0.06]">
                  <PromptField
                    value={negativePrompt}
                    onChange={setNegativePrompt}
                    placeholder="Negative — what to avoid…"
                    className="text-gray-400"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {!needPrompt && (
            <div className="px-3.5 py-3 t-body text-gray-500">
              {noPromptHint(meta.id)}
            </div>
          )}

          {/* Action bar */}
          <div className="flex items-center gap-1.5 px-2.5 py-2 border-t border-white/[0.05]">
            {needPrompt && negSupported && (
              <button
                onClick={toggleNegative}
                className={cn('t-control px-2 h-[var(--control-h-sm)] rounded-md transition-colors', showNegative ? 'bg-white/10 text-gray-200' : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.05]')}
                title="Negative prompt"
              >
                Neg
              </button>
            )}
            {needPrompt && <PromptHistory onPick={setPrompt} />}
            <div className="flex-1" />
            {/* The backend axis moved to the global header switch (2.5.7) —
                the Composer just reflects it via the CreditsMeter. */}
            {backend === 'cloud' && <CreditsMeter />}
            {meta.id === 'upscale' && (
              <Tooltip content="Target resolution for the super-resolution pass.">
                <div>
                  <Segmented
                    size="sm"
                    layoutId="upscale-res"
                    value={targetResolution}
                    onChange={(v) => setTargetResolution(v as '2k' | '4k' | '8k')}
                    options={[{ value: '2k', label: '2K' }, { value: '4k', label: '4K' }, { value: '8k', label: '8K' }]}
                  />
                </div>
              </Tooltip>
            )}
            {!isUtility && (
              <>
                <ModelChip />
                <Tooltip content="All advanced settings — sampler, seed, LoRA, VAE and more.">
                  <Button variant="ghost" size="sm" icon={SlidersHorizontal} iconOnly onClick={onOpenAdvanced} title="Advanced settings" />
                </Tooltip>
              </>
            )}
            {isGenerating ? (
              <Button variant="danger" size="md" icon={X} onClick={guardedCancel}>Cancel</Button>
            ) : (
              <Button variant="primary" size="lg" icon={Sparkles} disabled={!canGenerate} onClick={guardedGenerate}>Create</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Caption for prompt-less intents so each reads honestly (the old copy said
// "remove the background" for every one of them — misleading the eraser into
// a guaranteed "Paint a mask first" error).
function noPromptHint(id: CreateIntent): string {
  switch (id) {
    case 'upscale':
      return 'No prompt needed — just hit Create to enhance the image.'
    case 'eraser':
      return 'No prompt needed — paint a mask over the object to remove, then hit Create.'
    case 'character':
      return 'Add 4-30 photos of one person or character above, pick a trigger word, then hit Create to train.'
    case 'lipsync':
      return 'Add the portrait (or clip) and a voice above, then hit Create to make it speak.'
    case 'motion':
      return 'Add a character image and a driving dance/pose video above, then hit Create.'
    default:
      return 'No prompt needed — just hit Create to remove the background.'
  }
}

// Quality (proxy over steps) + Aspect (image) + Edit strength (edit).
function QuickControls() {
  const intent = useCreateStore((s) => s.intent())
  const meta = INTENT_MAP[intent]
  const steps = useCreateStore((s) => s.steps)
  const setSteps = useCreateStore((s) => s.setSteps)
  const denoise = useCreateStore((s) => s.denoise)
  const setDenoise = useCreateStore((s) => s.setDenoise)
  const imageModelType = useCreateStore((s) => s.imageModelType)
  const width = useCreateStore((s) => s.width)
  const height = useCreateStore((s) => s.height)
  const setSize = useCreateStore((s) => s.setSize)

  const base = MODEL_TYPE_DEFAULTS[imageModelType]?.steps ?? 25
  const qSteps = { Draft: Math.round(base * 0.6), Standard: base, High: Math.round(base * 1.5) }
  const activeQ = nearestKey(qSteps, steps)

  return (
    <div className="flex items-center justify-center gap-3 flex-wrap">
      <div className="flex items-center gap-2" style={{ transform: 'scale(0.7)', transformOrigin: 'center' }}>
      <LabeledControl label="Quality">
        <Segmented
          size="sm"
          layoutId="quality"
          value={activeQ}
          onChange={(k) => setSteps(qSteps[k as keyof typeof qSteps])}
          options={[{ value: 'Draft', label: 'Draft' }, { value: 'Standard', label: 'Standard' }, { value: 'High', label: 'High' }]}
        />
      </LabeledControl>

      {/* Aspect only where the output size is actually user-chosen — a pure
          from-scratch image. Edit/mask ops force the output to the source
          image's dimensions (useCloudCreate overrides w/h from the source), so
          the control was dead there; video has no aspect knob at all. */}
      {!meta.isVideo && !meta.needsSource && (
        <LabeledControl label="Aspect">
          <Segmented
            size="sm"
            layoutId="aspect"
            value={aspectKey(width, height)}
            onChange={(k) => { const p = aspectPresets(imageModelType)[k as AspectKey]; setSize(p.w, p.h) }}
            options={[
              { value: '1:1', label: '1:1', icon: Square },
              { value: '3:4', label: '3:4' },
              { value: '4:3', label: '4:3' },
              { value: '16:9', label: '16:9' },
            ]}
          />
        </LabeledControl>
      )}
      </div>

      {meta.id === 'edit' && (
        <div className="w-44">
          <Slider label="Edit strength" min={0.05} max={1} step={0.05} value={denoise} onChange={setDenoise} format={(v) => v.toFixed(2)} />
        </div>
      )}
    </div>
  )
}

function LabeledControl({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="t-label text-gray-600">{label}</span>
      {children}
    </div>
  )
}

function PromptHistory({ onPick }: { onPick: (p: string) => void }) {
  const history = useCreateStore((s) => s.promptHistory)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)
  if (history.length === 0) return null
  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" size="sm" icon={History} iconOnly title="Prompt history" onClick={() => setOpen((o) => !o)} />
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className="lu-elevated absolute bottom-full mb-1.5 left-0 z-50 w-72 rounded-lg p-1 max-h-64 overflow-y-auto scrollbar-thin"
          >
            {history.map((h, i) => (
              <button key={i} onClick={() => { onPick(h); setOpen(false) }} className="w-full text-left t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06] truncate">{h}</button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── aspect helpers ──
type AspectKey = '1:1' | '3:4' | '4:3' | '16:9'
const RATIO: Record<AspectKey, number> = { '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3, '16:9': 16 / 9 }

function snap64(n: number): number { return Math.max(64, Math.round(n / 64) * 64) }

function aspectPresets(modelType: string): Record<AspectKey, { w: number; h: number }> {
  const def = MODEL_TYPE_DEFAULTS[modelType as keyof typeof MODEL_TYPE_DEFAULTS] ?? MODEL_TYPE_DEFAULTS.sdxl
  const baseLong = Math.max(def.width, def.height)
  const out = {} as Record<AspectKey, { w: number; h: number }>
  for (const k of Object.keys(RATIO) as AspectKey[]) {
    const r = RATIO[k]
    out[k] = r >= 1 ? { w: baseLong, h: snap64(baseLong / r) } : { w: snap64(baseLong * r), h: baseLong }
  }
  return out
}

function aspectKey(w: number, h: number): AspectKey {
  const r = w / h
  let best: AspectKey = '1:1'; let bestD = Infinity
  for (const k of Object.keys(RATIO) as AspectKey[]) {
    const d = Math.abs(RATIO[k] - r)
    if (d < bestD) { bestD = d; best = k }
  }
  return best
}

function nearestKey(map: Record<string, number>, val: number): string {
  let best = Object.keys(map)[0]; let bestD = Infinity
  for (const [k, v] of Object.entries(map)) { const d = Math.abs(v - val); if (d < bestD) { bestD = d; best = k } }
  return best
}
