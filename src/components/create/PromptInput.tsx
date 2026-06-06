import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Square, ChevronDown, ChevronUp, History, X } from 'lucide-react'
import { useCreateStore } from '../../stores/createStore'
import { classifyModel, isI2VModel } from '../../api/comfyui'
import type { ClassifiedModel } from '../../api/comfyui'

interface Props {
  onGenerate: () => void
  onCancel: () => void
  disabled?: boolean
  imageModels: ClassifiedModel[]
  videoModels: ClassifiedModel[]
}

export function PromptInput({ onGenerate, onCancel, disabled, imageModels, videoModels }: Props) {
  const {
    prompt, negativePrompt, isGenerating, promptHistory, mode, imageSubMode, videoSubMode,
    imageModel, videoModel, setPrompt, setNegativePrompt, setImageSubMode, setVideoSubMode,
    setImageModel, setVideoModel,
  } = useCreateStore()

  // Model picker (lives right next to Generate). Video models are filtered by
  // the T2V/I2V sub-mode so the list only shows compatible checkpoints.
  const modelOptions = mode === 'video'
    ? videoModels.filter((m) => (videoSubMode === 'i2v' ? isI2VModel(m.name) : !isI2VModel(m.name)))
    : imageModels
  const activeModelValue = mode === 'video' ? videoModel : imageModel
  const onModelChange = (name: string) => {
    if (mode === 'video') setVideoModel(name)
    else setImageModel(name, classifyModel(name))
  }
  const [showNegative, setShowNegative] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isMac = navigator.platform.toUpperCase().includes('MAC')

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault()
      if (!isGenerating && prompt.trim()) onGenerate()
    }
  }

  const selectFromHistory = (p: string) => {
    setPrompt(p)
    setShowHistory(false)
    textareaRef.current?.focus()
  }

  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#2a2a2a] overflow-hidden">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you want to create..."
            rows={3}
            className="w-full bg-transparent resize-none text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none text-sm leading-relaxed p-4"
            disabled={isGenerating || disabled}
            aria-label="Image or video generation prompt"
          />
          {/* Prompt history button */}
          {promptHistory.length > 0 && (
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="absolute top-2 right-2 p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
              title="Prompt history"
              aria-label="Prompt history"
            >
              <History size={14} />
            </button>
          )}
        </div>

        {/* Prompt history dropdown */}
        <AnimatePresence>
          {showHistory && promptHistory.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="border-t border-gray-200 dark:border-white/10 max-h-32 overflow-y-auto"
            >
              {promptHistory.map((p, i) => (
                <button
                  key={i}
                  onClick={() => selectFromHistory(p)}
                  className="w-full text-left px-4 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 truncate transition-colors"
                >
                  {p}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 dark:border-white/5">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowNegative(!showNegative)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              {showNegative ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              Negative prompt
            </button>
            {/* Text-to-Image / Image-to-Image — on the main screen (next to
                the negative-prompt toggle) so it's reachable without opening
                the Advanced parameters. Drives the existing `imageSubMode`
                store field that gates the I2I upload + denoise controls. */}
            {mode === 'image' && (
              <div className="flex items-center rounded-md border border-gray-200 dark:border-white/10 overflow-hidden text-[0.6rem]">
                <button
                  onClick={() => setImageSubMode('text2img')}
                  className={`px-1.5 py-0.5 font-medium transition-colors ${imageSubMode === 'text2img' ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
                  title="Text to Image"
                >T2I</button>
                <button
                  onClick={() => setImageSubMode('img2img')}
                  className={`px-1.5 py-0.5 font-medium transition-colors ${imageSubMode === 'img2img' ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
                  title="Image to Image"
                >I2I</button>
              </div>
            )}
            {/* Text-to-Video / Image-to-Video — mirrors the image T2I/I2I switch
                so the video mode is fully selectable from the main screen
                (drives `videoSubMode`, which filters the model list + gates the
                I2V image upload in CreateView). */}
            {mode === 'video' && (
              <div className="flex items-center rounded-md border border-gray-200 dark:border-white/10 overflow-hidden text-[0.6rem]">
                <button
                  onClick={() => setVideoSubMode('t2v')}
                  className={`px-1.5 py-0.5 font-medium transition-colors ${videoSubMode === 't2v' ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
                  title="Text to Video"
                >T2V</button>
                <button
                  onClick={() => setVideoSubMode('i2v')}
                  className={`px-1.5 py-0.5 font-medium transition-colors ${videoSubMode === 'i2v' ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
                  title="Image to Video"
                >I2V</button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {prompt.trim() && !isGenerating && (
              <button onClick={() => setPrompt('')} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" aria-label="Clear prompt">
                <X size={14} />
              </button>
            )}
            {/* Model picker — sits directly left of Generate so the active
                image / video model is always visible + switchable without
                opening Advanced. Hidden until models are discovered. */}
            {modelOptions.length > 0 && (
              <select
                value={activeModelValue}
                onChange={(e) => onModelChange(e.target.value)}
                disabled={isGenerating || disabled}
                title={activeModelValue || `Select ${mode} model`}
                aria-label={`${mode} model`}
                className="max-w-[160px] px-2 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 text-xs focus:outline-none focus:border-gray-400 dark:focus:border-white/20 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {modelOptions.map((m) => (
                  <option key={m.name} value={m.name}>{m.name.replace(/\.[^.]+$/, '')}</option>
                ))}
              </select>
            )}
            {isGenerating ? (
              <motion.button
                onClick={onCancel}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-red-100 dark:bg-red-500/20 border border-red-300 dark:border-red-500/30 text-red-600 dark:text-red-400 text-sm font-medium"
                whileTap={{ scale: 0.95 }}
              >
                <Square size={14} /> Cancel
              </motion.button>
            ) : (
              <motion.button
                onClick={onGenerate}
                disabled={!prompt.trim() || disabled}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-gray-800 dark:bg-white/10 text-white text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:bg-gray-700 dark:hover:bg-white/15 transition-all"
                whileTap={{ scale: 0.95 }}
              >
                <Sparkles size={14} /> Generate
              </motion.button>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showNegative && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#2a2a2a] overflow-hidden"
          >
            <textarea
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              placeholder="What to avoid (e.g. blurry, low quality, watermark)..."
              rows={2}
              className="w-full bg-transparent resize-none text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none text-sm leading-relaxed p-4"
              disabled={isGenerating}
              aria-label="Negative prompt"
            />
          </motion.div>
        )}
      </AnimatePresence>

      <p className="text-xs text-gray-400 text-center">{isMac ? 'Cmd' : 'Ctrl'}+Enter to generate</p>
    </div>
  )
}
