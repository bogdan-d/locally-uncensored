import { useCreateStore } from '../../stores/createStore'
import { SliderControl } from '../settings/SliderControl'
import { Dice5 } from 'lucide-react'

interface Props {
  checkpoints: string[]
  videoModels: string[]
  samplerList: string[]
}

const IMG_SIZE_PRESETS = [
  { label: '512', w: 512, h: 512 },
  { label: '768', w: 768, h: 768 },
  { label: '1024', w: 1024, h: 1024 },
  { label: '768x1344', w: 768, h: 1344 },
  { label: '1344x768', w: 1344, h: 768 },
]

const VID_SIZE_PRESETS = [
  { label: '480p', w: 832, h: 480 },
  { label: '512', w: 512, h: 512 },
  { label: '768x480', w: 768, h: 480 },
  { label: '480x768', w: 480, h: 768 },
]

export function ParamPanel({ checkpoints, videoModels, samplerList }: Props) {
  const store = useCreateStore()
  const isVideo = store.mode === 'video'
  const sizePresets = isVideo ? VID_SIZE_PRESETS : IMG_SIZE_PRESETS
  const modelList = isVideo ? videoModels : checkpoints

  const selectClass = 'w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-300 dark:border-white/10 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-gray-400 dark:focus:border-white/20 appearance-none cursor-pointer'

  return (
    <div className="space-y-4">
      {/* Model */}
      <div>
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
          {isVideo ? 'Video Model' : 'Image Model'}
        </label>
        <select value={store.model} onChange={(e) => store.setModel(e.target.value)} className={selectClass}>
          {modelList.length === 0 && <option value="">No models found</option>}
          {modelList.map((c) => (
            <option key={c} value={c}>{c.replace(/\.[^.]+$/, '')}</option>
          ))}
        </select>
      </div>

      {/* Sampler */}
      <div>
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">Sampler</label>
        <select value={store.sampler} onChange={(e) => store.setSampler(e.target.value)} className={selectClass}>
          {samplerList.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* Steps */}
      <SliderControl label="Steps" value={store.steps} min={1} max={50} step={1} onChange={store.setSteps} />

      {/* CFG Scale */}
      <SliderControl label="CFG Scale" value={store.cfgScale} min={1} max={20} step={0.5} onChange={store.setCfgScale} />

      {/* Size Presets */}
      <div>
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
          Size ({store.width}x{store.height})
        </label>
        <div className="flex flex-wrap gap-1.5">
          {sizePresets.map((preset) => (
            <button
              key={preset.label}
              onClick={() => { store.setWidth(preset.w); store.setHeight(preset.h) }}
              className={`px-2 py-1 rounded text-xs transition-all ${
                store.width === preset.w && store.height === preset.h
                  ? 'bg-gray-800 dark:bg-white/15 text-white'
                  : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'
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
            className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-300 dark:border-white/10 text-gray-900 dark:text-white text-sm focus:outline-none font-mono"
            placeholder="-1 = random"
          />
          <button
            onClick={() => store.setSeed(-1)}
            className="p-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-300 dark:border-white/10 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
            title="Random seed"
          >
            <Dice5 size={16} />
          </button>
        </div>
      </div>

      {/* Video-specific params */}
      {isVideo && (
        <>
          <SliderControl label="Frames" value={store.frames} min={8} max={81} step={1} onChange={store.setFrames} />
          <SliderControl label="FPS" value={store.fps} min={4} max={30} step={1} onChange={store.setFps} />
        </>
      )}
    </div>
  )
}
