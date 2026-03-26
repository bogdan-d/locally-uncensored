import { useCreateStore } from '../../stores/createStore'
import { SliderControl } from '../settings/SliderControl'
import { Dice5, Info, AlertTriangle } from 'lucide-react'
import type { ClassifiedModel, ModelType } from '../../api/comfyui'
import { snapToVideoGrid } from '../../api/comfyui'

interface Props {
  imageModels: ClassifiedModel[]
  videoModels: ClassifiedModel[]
  samplerList: string[]
  schedulerList: string[]
  modelsLoaded: boolean
}

const IMG_SIZE_PRESETS = [
  { label: '512', w: 512, h: 512 },
  { label: '768', w: 768, h: 768 },
  { label: '1024', w: 1024, h: 1024 },
  { label: '768x1344', w: 768, h: 1344 },
  { label: '1344x768', w: 1344, h: 768 },
]

const VID_SIZE_PRESETS = [
  { label: '480p', w: 848, h: 480 },
  { label: '640x480', w: 640, h: 480 },
  { label: '512', w: 512, h: 512 },
  { label: '480x848', w: 480, h: 848 },
]

const TYPE_BADGE: Record<ModelType, { label: string; color: string }> = {
  flux: { label: 'FLUX', color: 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300' },
  flux2: { label: 'FLUX 2', color: 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300' },
  sdxl: { label: 'SDXL', color: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300' },
  sd15: { label: 'SD 1.5', color: 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300' },
  wan: { label: 'Wan', color: 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300' },
  hunyuan: { label: 'Hunyuan', color: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300' },
  unknown: { label: 'Model', color: 'bg-gray-100 dark:bg-gray-500/20 text-gray-700 dark:text-gray-300' },
}

export function ParamPanel({ imageModels, videoModels, samplerList, schedulerList, modelsLoaded }: Props) {
  const store = useCreateStore()
  const isVideo = store.mode === 'video'
  const sizePresets = isVideo ? VID_SIZE_PRESETS : IMG_SIZE_PRESETS
  const models = isVideo ? videoModels : imageModels

  const selectClass = 'w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-gray-400 dark:focus:border-white/20 appearance-none cursor-pointer'

  const handleModelChange = (name: string) => {
    if (isVideo) {
      store.setVideoModel(name)
    } else {
      const model = imageModels.find(m => m.name === name)
      store.setImageModel(name, model?.type ?? 'unknown')
    }
  }

  const activeModel = isVideo ? store.videoModel : store.imageModel
  const videoDuration = isVideo ? (store.frames / store.fps).toFixed(1) : null

  return (
    <div className="space-y-4">
      {/* Model */}
      <div>
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
          {isVideo ? 'Video Model' : 'Image Model'}
        </label>
        {!modelsLoaded ? (
          <div className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-400 text-xs animate-pulse">
            Loading models...
          </div>
        ) : models.length === 0 ? (
          <div className="px-3 py-2 rounded-lg bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/20 text-yellow-700 dark:text-yellow-400 text-xs">
            {isVideo
              ? 'No video models found. Add Wan or Hunyuan models to ComfyUI.'
              : 'No image models found. Add checkpoints or FLUX models to ComfyUI.'}
          </div>
        ) : (
          <>
            <select value={activeModel} onChange={(e) => handleModelChange(e.target.value)} className={selectClass}>
              {models.map((m) => {
                const badge = TYPE_BADGE[m.type]
                const shortName = m.name.replace(/\.[^.]+$/, '')
                return <option key={m.name} value={m.name}>{shortName} ({badge.label})</option>
              })}
            </select>
            {activeModel && (() => {
              const model = models.find(m => m.name === activeModel)
              if (!model) return null
              const badge = TYPE_BADGE[model.type]
              return (
                <span className={`mt-1 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${badge.color}`}>
                  {badge.label}
                </span>
              )
            })()}
          </>
        )}
      </div>

      {/* Sampler */}
      <div>
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">Sampler</label>
        <select value={store.sampler} onChange={(e) => store.setSampler(e.target.value)} className={selectClass}>
          {samplerList.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Scheduler */}
      <div>
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">Scheduler</label>
        <select value={store.scheduler} onChange={(e) => store.setScheduler(e.target.value)} className={selectClass}>
          {schedulerList.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Steps */}
      <SliderControl label="Steps" value={store.steps} min={1} max={50} step={1} onChange={store.setSteps} />

      {/* CFG Scale */}
      <SliderControl label="CFG Scale" value={store.cfgScale} min={0} max={30} step={0.5} onChange={store.setCfgScale} />

      {/* Batch Size */}
      {!isVideo && (
        <SliderControl label="Batch Size" value={store.batchSize} min={1} max={4} step={1} onChange={store.setBatchSize} />
      )}

      {/* Size Presets */}
      <div>
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
          Size ({store.width}x{store.height})
        </label>
        <div className="flex flex-wrap gap-1.5">
          {sizePresets.map((preset) => (
            <button
              key={preset.label}
              onClick={() => store.setSize(preset.w, preset.h)}
              className={`px-2 py-1 rounded text-xs transition-all ${
                store.width === preset.w && store.height === preset.h
                  ? 'bg-gray-800 dark:bg-white/15 text-white'
                  : 'bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Seed */}
      <div>
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">Seed</label>
        <div className="flex gap-2">
          <input
            type="number"
            value={store.seed}
            onChange={(e) => store.setSeed(parseInt(e.target.value) || -1)}
            className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white text-sm focus:outline-none font-mono"
            placeholder="-1 = random"
            aria-label="Seed value, -1 for random"
          />
          <button
            onClick={() => store.setSeed(-1)}
            className="p-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
            title="Random seed"
          >
            <Dice5 size={16} />
          </button>
        </div>
      </div>

      {/* Video-specific params */}
      {isVideo && (
        <>
          <SliderControl label="Frames" value={store.frames} min={1} max={81} step={4} onChange={store.setFrames} />
          <SliderControl label="FPS" value={store.fps} min={4} max={30} step={1} onChange={store.setFps} />
          <div className="flex items-center gap-1 text-xs text-gray-400">
            <Info size={12} />
            <span>Duration: ~{videoDuration}s ({store.frames} frames at {store.fps} fps)</span>
          </div>
          {(store.width % 16 !== 0 || store.height % 16 !== 0) && (
            <button
              onClick={() => {
                const snapped = snapToVideoGrid(store.width, store.height)
                store.setSize(snapped.width, snapped.height)
              }}
              className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400 hover:underline"
            >
              <AlertTriangle size={12} /> Size must be multiple of 16 — click to fix ({snapToVideoGrid(store.width, store.height).width}x{snapToVideoGrid(store.width, store.height).height})
            </button>
          )}
          {store.frames > 40 && (
            <div className="flex items-center gap-1 text-xs text-orange-500">
              <AlertTriangle size={12} /> High frame count — may need 10+ GB VRAM
            </div>
          )}
        </>
      )}
    </div>
  )
}
