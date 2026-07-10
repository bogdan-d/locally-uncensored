import { Gauge, Boxes, FlaskConical, RotateCcw, HelpCircle } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { cloudModelById, defaultCloudModel } from '../../../stores/cloudCatalogStore'
import { INTENT_MAP } from './intents'
import { SAMPLERS as SAMPLERS_FALLBACK, SCHEDULERS as SCHEDULERS_FALLBACK } from './badges'
import { Section } from '../ui/Section'
import { Slider } from '../ui/Slider'
import { Select } from '../ui/Select'
import { NumberField } from '../ui/NumberField'
import { Button } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { cn } from '../ui/cn'

// The full param surface, reorganized into 3 frequency-ranked Sections.
// Sampler/scheduler/LoRA/VAE lists come live from ComfyUI via CreateContext,
// falling back to the standard node names until they load.
export function ParamGroups() {
  const s = useCreateStore()
  const { samplerList, schedulerList, loraList, vaeList } = useCreateExp()
  const meta = INTENT_MAP[s.intent()]
  const isVideo = meta.isVideo
  const isEdit = meta.id === 'edit'
  const isCloud = s.backend === 'cloud'

  // On cloud the worker only honours steps for images and guidance_scale for
  // the flux family — hide the sliders elsewhere rather than show a dead
  // control. Sampler/scheduler/LoRA/VAE/clip-skip/batch have no cloud path at
  // all (useCloudCreate never sends them), so they're local-only knobs.
  const cloudModelId =
    (isVideo ? s.cloudVideoModel : s.cloudImageModel) || defaultCloudModel(isVideo ? 'video' : 'image').id
  const showSteps = !(isCloud && isVideo)
  const showCfg = isCloud ? cloudModelById(cloudModelId)?.cfg === true : true

  const samplers = samplerList.length ? samplerList : SAMPLERS_FALLBACK
  const schedulers = schedulerList.length ? schedulerList : SCHEDULERS_FALLBACK
  const vaes = vaeList.length ? vaeList : ['auto']

  return (
    <div className="py-1">
      {/* QUALITY */}
      <Section title="Quality" icon={Gauge} defaultOpen
        right={<Button variant="ghost" size="sm" icon={RotateCcw} iconOnly title="Reset to model defaults" onClick={s.resetParamsToModelDefaults} />}
      >
        {showSteps && <Slider label="Steps" min={1} max={60} step={1} value={s.steps} onChange={s.setSteps} />}
        {showCfg && <Slider label={isVideo ? 'Guidance' : 'CFG scale'} min={0} max={30} step={0.5} value={s.cfgScale} onChange={s.setCfgScale} format={(v) => v.toFixed(1)} />}
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Width" value={s.width} min={64} max={4096} step={64} mono onChange={(v) => s.setSize(v, s.height)} suffix="px" />
          <NumberField label="Height" value={s.height} min={64} max={4096} step={64} mono onChange={(v) => s.setSize(s.width, v)} suffix="px" />
        </div>
      </Section>

      {/* OUTPUT */}
      <Section title="Output" icon={Boxes} defaultOpen>
        <NumberField label="Seed (−1 = random)" value={s.seed} step={1} mono onRandomize={() => s.setSeed(-1)} onChange={s.setSeed} />
        {/* Batch size has no cloud path — CloudJobParams carries no batch
            field and useCloudCreate always stamps 1. */}
        {!isVideo && !isCloud && <Slider label="Batch size" min={1} max={8} step={1} value={s.batchSize} onChange={s.setBatchSize} />}
        {isVideo && (
          <div className="grid grid-cols-2 gap-2">
            <Slider label="Frames" min={1} max={120} step={1} value={s.frames} onChange={s.setFrames} />
            <Slider label="FPS" min={1} max={60} step={1} value={s.fps} onChange={s.setFps} />
          </div>
        )}
      </Section>

      {/* EXPERT */}
      <Section title="Expert" icon={FlaskConical} defaultOpen={false}>
        {/* Sampler/Scheduler are ComfyUI-only knobs — the hosted WaveSpeed
            endpoints don't accept them, so hide them on the cloud backend
            rather than let the user tune a control that's silently dropped. */}
        {!isCloud && (
          <>
            <Field label="Sampler" help="The algorithm that turns noise into your image. dpmpp_2m / euler are safe all-rounders.">
              <Select size="sm" options={samplers.map((x) => ({ value: x, label: x }))} value={s.sampler} onChange={s.setSampler} />
            </Field>
            <Field label="Scheduler" help="How the denoise steps are spaced. karras is a good default for SDXL; simple for FLUX.">
              <Select size="sm" options={schedulers.map((x) => ({ value: x, label: x }))} value={s.scheduler} onChange={s.setScheduler} />
            </Field>
          </>
        )}

        {isEdit && (
          <Slider label="Denoise (raw)" min={0.05} max={1} step={0.05} value={s.denoise} onChange={s.setDenoise} format={(v) => v.toFixed(2)} />
        )}
        {meta.allowsMask && (
          <Slider label="Mask edge feather" min={0} max={64} step={1} value={s.growMaskBy} onChange={s.setGrowMaskBy} unit="px" />
        )}

        {!isCloud && !isVideo && loraList.length > 0 && (
          <div className="space-y-1.5">
            <div className="t-control text-gray-400">LoRA stack {s.selectedLoras.length > 0 && <span className="t-mono text-gray-600">· {s.selectedLoras.length} active</span>}</div>
            <div className="space-y-1 max-h-44 overflow-y-auto scrollbar-thin">
              {loraList.map((name) => {
                const active = s.selectedLoras.find((l) => l.name === name)
                return (
                  <div key={name} className={cn('rounded-md border transition-colors', active ? 'border-white/15 bg-white/[0.06]' : 'border-white/[0.06]')}>
                    <button onClick={() => s.toggleLora(name)} className="w-full flex items-center justify-between px-2.5 py-1.5 t-control text-left text-gray-300">
                      <span className="truncate">{name.replace(/\.safetensors$/, '')}</span>
                      <span className={cn('t-mono', active ? 'text-emerald-400' : 'text-gray-600')}>{active ? 'on' : 'off'}</span>
                    </button>
                    {active && (
                      <div className="px-2.5 pb-2">
                        <Slider min={0} max={2} step={0.05} value={active.strength} onChange={(v) => s.setLoraStrengthFor(name, v)} format={(v) => v.toFixed(2)} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {!isCloud && !isVideo && (
          <Field label="VAE" help="Override the checkpoint's built-in VAE. 'auto' lets the checkpoint decide.">
            <Select size="sm" options={vaes.map((v) => ({ value: v, label: v }))} value={s.selectedVae} onChange={s.setSelectedVae} />
          </Field>
        )}
        {!isCloud && !isVideo && (
          <Slider label="Skip CLIP layers" min={0} max={12} step={1} value={s.clipSkip} onChange={s.setClipSkip} />
        )}
      </Section>
    </div>
  )
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="t-control text-gray-400">{label}</span>
        {help && <HelpDot help={help} />}
      </div>
      {children}
    </div>
  )
}

function HelpDot({ help }: { help: string }) {
  return (
    <Tooltip content={help} side="bottom">
      <HelpCircle size={12} className="text-gray-600 hover:text-gray-400" />
    </Tooltip>
  )
}
