import { useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { UploadCloud, ImagePlus, Scissors, Wand2, Sparkles, X, Loader2, Download, AlertTriangle } from 'lucide-react'
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
  /** Adopt a finished result as the edit source, THEN open the mask editor —
   *  a t2i run leaves `source` empty, and the editor always reads `source`. */
  onEditResult: (item: GalleryItem) => void
  onFullscreen: (item: GalleryItem) => void
}

export function Stage({ displayed, onOpenMaskEditor, onEditResult, onFullscreen }: Props) {
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
        onSendToEditor={displayed.type === 'image' ? () => onEditResult(displayed) : undefined}
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
    // stray .txt/.pdf gets a message instead of a silent no-op. Exotic image
    // containers (HEIC/AVIF/GIF) pass: loadImageRef re-encodes them to PNG,
    // and throws honestly when the WebView can't decode them.
    if (!file.type.startsWith('image/')) {
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
  const setError = useCreateStore((s) => s.setError)
  const inputRef = useRef<HTMLInputElement>(null)
  // Same validation + error surface as the drop zone — this picker used to
  // hand the raw file straight to loadImageRef, so a .heic/.avif previewed
  // fine and then 415ed at submit (and a decode failure rejected unhandled).
  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('That file type is not supported — use PNG, JPG or WebP.')
      return
    }
    setError(null)
    try {
      onChange(await loadImageRef(file))
    } catch (err) {
      setError(`Could not load the image: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return (
    <>
      <Button variant="ghost" icon={ImagePlus} onClick={() => inputRef.current?.click()}>Change image</Button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f) }} />
    </>
  )
}

// ── Capability missing → one-click install right here ──
function CapabilityCard({ cap }: { cap: 'rmbg' }) {
  const { installCapability } = useCreateExp()
  const [installing, setInstalling] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const run = async () => {
    setInstalling(true); setErr(null); setStatus('Starting…')
    try {
      // On success caps.rmbg flips true and Stage swaps this card for the input slot.
      await installCapability(cap, setStatus)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <EmptyState
      icon={Scissors}
      tone="accent"
      title="Background removal needs a one-time download"
      description="The AI cutout runs fully locally (ComfyUI-RMBG). This installs the node now — the ~300 MB cutout model downloads automatically on your first cutout."
    >
      <div className="flex flex-col items-center gap-2.5 pt-1">
        {installing ? (
          <div className="t-control text-gray-400 flex items-center gap-2">
            <Loader2 size={14} className="animate-spin shrink-0" />
            <span>{status || 'Installing…'}</span>
          </div>
        ) : (
          <Button variant="primary" icon={Download} onClick={run}>Download &amp; install</Button>
        )}
        {err && (
          <div className="relative t-control text-gray-300 bg-white/[0.03] rounded-[var(--radius-control)] px-2.5 py-2 pr-7 max-w-sm text-left">
            <div className="flex items-start gap-2">
              <AlertTriangle size={13} className="text-gray-400 shrink-0 mt-px" />
              <span className="min-w-0 break-words">{err}</span>
            </div>
            <button onClick={() => setErr(null)} className="absolute top-1.5 right-1.5 text-gray-500 hover:text-gray-300 transition-colors" title="Dismiss" aria-label="Dismiss">
              <X size={12} />
            </button>
          </div>
        )}
      </div>
    </EmptyState>
  )
}
