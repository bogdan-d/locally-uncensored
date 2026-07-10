import { useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { UploadCloud, ImagePlus, Scissors, Wand2, Sparkles, X, Loader2 } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { INTENT_MAP } from './intents'
import { GeneratingView, ResultView } from './OutputView'
import { EmptyState } from '../ui/EmptyState'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { loadImageRef } from './loadImage'

interface Props {
  displayed?: GalleryItem
  onOpenMaskEditor: () => void
  onFullscreen: (item: GalleryItem) => void
}

export function Stage({ displayed, onOpenMaskEditor, onFullscreen }: Props) {
  const intent = useCreateStore((s) => s.intent())
  const meta = INTENT_MAP[intent]
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const source = useCreateStore((s) => s.source)
  const sourceSetAt = useCreateStore((s) => s.sourceSetAt)
  const setPrompt = useCreateStore((s) => s.setPrompt)
  const caps = useCreateStore((s) => s.caps)
  const backend = useCreateStore((s) => s.backend)
  // On the cloud backend the utility ops (background removal, …) run on
  // WaveSpeed's hosted endpoints — there's no local ComfyUI node to install,
  // so the capability is always ready. Only the local backend gates on the
  // node probe (which never runs without a local ComfyUI and would strand
  // cloud users on a dead "Open Model Manager" card).
  const capReady = !meta.capability || backend === 'cloud' || !!caps[meta.capability]

  // A result counts for the current source only if it was generated after the
  // source was loaded — otherwise an older gallery item would hijack the stage.
  const freshResult = displayed && displayed.createdAt >= sourceSetAt

  let body: React.ReactNode
  if (isGenerating) {
    body = <GeneratingView />
  } else if (meta.capability && !capReady) {
    body = <CapabilityCard cap={meta.capability} />
  } else if (meta.needsSource && !source) {
    body = <InputSlot />
  } else if (meta.needsSource && source && !freshResult) {
    body = <SourcePreview onOpenMaskEditor={onOpenMaskEditor} />
  } else if (displayed) {
    body = (
      <ResultView
        item={displayed}
        onFullscreen={() => onFullscreen(displayed)}
        onSendToEditor={!meta.isVideo ? onOpenMaskEditor : undefined}
      />
    )
  } else {
    body = (
      <EmptyState icon={Sparkles} logoSrc="/LU-monogram-white.png" title={teachTitle(intent)}>
        {meta.examples.length > 0 && (
          <div className="flex flex-wrap justify-center gap-1.5 pt-1">
            {meta.examples.map((ex) => (
              <button
                key={ex}
                onClick={() => setPrompt(ex)}
                className="t-control text-gray-400 px-2.5 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.06] hover:border-white/15 hover:text-gray-200 transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </EmptyState>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.div
          key={intent + (isGenerating ? ':gen' : '')}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="flex-1 min-h-0 flex flex-col"
        >
          {body}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function teachTitle(intent: string): string {
  switch (intent) {
    case 'image': return 'What do you want to create?'
    case 'video': return 'Describe a scene to animate'
    default: return 'Get started'
  }
}

// ── Source upload dropzone ──
function InputSlot() {
  const setSource = useCreateStore((s) => s.setSource)
  const setError = useCreateStore((s) => s.setError)
  const intent = useCreateStore((s) => s.intent())
  const meta = INTENT_MAP[intent]
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleFile = async (file: File) => {
    // Drag&drop bypasses the input's accept filter — validate here so a
    // stray .txt/.pdf gets a message instead of a silent no-op.
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      setError('That file type is not supported — use PNG, JPG or WebP.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      setSource(await loadImageRef(file))
    } catch (err) {
      setError(`Could not load the image: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6">
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
        className={cn(
          'w-full max-w-sm aspect-[5/4] min-h-[220px] max-h-[44vh] rounded-[var(--radius-panel)] border-2 border-dashed flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors',
          drag ? 'border-blue-400 bg-blue-500/10' : 'border-white/10 bg-white/[0.02] hover:border-white/20',
        )}
      >
        {loading ? <Loader2 className="animate-spin text-gray-400" size={28} /> : (
          meta.id === 'removebg' ? <Scissors className="text-gray-500" size={28} strokeWidth={1.5} /> : <UploadCloud className="text-gray-500" size={28} strokeWidth={1.5} />
        )}
        <div className="text-center">
          <div className="t-title text-gray-300">{meta.id === 'removebg' ? 'Drop an image to cut out' : meta.id === 'animate' ? 'Drop an image to animate' : 'Drop an image to edit'}</div>
          <div className="t-body text-gray-600">or click to browse · PNG, JPG, WebP</div>
        </div>
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
      </div>
    </div>
  )
}

// ── Source loaded, awaiting generation ──
function SourcePreview({ onOpenMaskEditor }: { onOpenMaskEditor: () => void }) {
  const source = useCreateStore((s) => s.source)
  const mask = useCreateStore((s) => s.mask)
  const setSource = useCreateStore((s) => s.setSource)
  const setMask = useCreateStore((s) => s.setMask)
  const intent = useCreateStore((s) => s.intent())
  const meta = INTENT_MAP[intent]

  // Zombie render: an intent switch drops the source in the same store update
  // that swaps this component out, but the child subscription can fire first.
  if (!source) return null

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6">
      <div className="relative">
        <img src={source.url} alt="source" className={cn('max-h-[52vh] max-w-full object-contain rounded-[var(--radius-panel)] border border-white/[0.06]', intent === 'removebg' && 'lu-checker')} />
        {mask && (
          <div className="absolute top-2 left-2 t-label text-gray-300 bg-black/50 px-2 py-1 rounded-md">mask painted</div>
        )}
        <button
          onClick={() => { setSource(null); setMask(null) }}
          className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-lg bg-black/50 text-gray-300 hover:text-white"
          title="Remove image"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex items-center gap-2 mt-4">
        {meta.allowsMask && (
          <Button variant="secondary" icon={Wand2} onClick={onOpenMaskEditor}>{mask ? 'Edit mask' : 'Paint mask'}</Button>
        )}
        <ChangeImageButton onChange={(r) => setSource(r)} />
      </div>
      <p className="t-body text-gray-600 mt-3 text-center max-w-sm">
        {meta.id === 'removebg' ? 'Hit Create to cut out the subject and export a transparent PNG.'
          : meta.id === 'upscale' ? 'Hit Create to upscale the image.'
          : meta.id === 'eraser' ? 'Paint a mask over the object to remove, then hit Create.'
          : meta.allowsMask ? 'Paint a mask over what should change, write the edit prompt below, then Create.'
          : 'Describe the motion below, then Create.'}
      </p>
    </div>
  )
}

function ChangeImageButton({ onChange }: { onChange: (r: Awaited<ReturnType<typeof loadImageRef>>) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button variant="ghost" icon={ImagePlus} onClick={() => inputRef.current?.click()}>Change image</Button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) onChange(await loadImageRef(f)) }} />
    </>
  )
}

// ── Capability missing → route to Model Manager ──
function CapabilityCard({ cap }: { cap: 'rmbg' }) {
  const { installCapability } = useCreateExp()
  return (
    <EmptyState
      icon={Scissors}
      tone="accent"
      title="Background Removal needs a quick one-time download"
      description="The AI cutout model (ComfyUI-RMBG / BiRefNet) runs fully locally. Get it from the Model Manager — about 300 MB — and this becomes a one-click action."
      action={{ label: 'Get this feature', icon: UploadCloud, onClick: () => installCapability(cap) }}
      secondaryAction={{ label: 'Open Model Manager', onClick: () => installCapability(cap) }}
    />
  )
}
