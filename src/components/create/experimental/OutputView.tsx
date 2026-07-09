import { motion } from 'framer-motion'
import { Cpu, Sparkles, ImageDown, Maximize2, Download, Wand2 } from 'lucide-react'
import { useCreateStore, type GalleryItem, type ProgressPhase } from '../../../stores/createStore'
import { downloadComfyFile } from '../../../api/backend'
import { galleryItemUrl } from './galleryUrl'
import { cn } from '../ui/cn'

function phaseIcon(phase: ProgressPhase) {
  if (phase === 'loading-model' || phase === 'loading-clip' || phase === 'loading-vae') return <Cpu size={20} className="text-amber-300" />
  if (phase === 'sampling') return <Sparkles size={20} className="text-green-300" />
  if (phase === 'decoding') return <ImageDown size={20} className="text-lu-accent" />
  return <Sparkles size={20} className="text-gray-400" />
}

// Generation progress — phase-aware animation.
export function GeneratingView() {
  const progressPhase = useCreateStore((s) => s.progressPhase)
  const progressText = useCreateStore((s) => s.progressText)
  const progress = useCreateStore((s) => s.progress)
  const isLoading = progressPhase === 'loading-model' || progressPhase === 'loading-clip' || progressPhase === 'loading-vae'

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="space-y-6 flex flex-col items-center">
        <div className="relative w-16 h-16">
          {isLoading ? (
            <>
              <motion.div className="absolute inset-0 rounded-full border border-amber-400/30" animate={{ scale: [1, 1.6], opacity: [0.5, 0] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeOut' }} />
              <div className="absolute inset-0 rounded-full border border-amber-400/20 flex items-center justify-center">
                <motion.div animate={{ rotate: 360 }} transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}>{phaseIcon(progressPhase)}</motion.div>
              </div>
            </>
          ) : progressPhase === 'sampling' ? (
            <>
              <motion.div className="absolute inset-0 rounded-full border border-green-400/30" animate={{ scale: [1, 1.8], opacity: [0.4, 0] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut' }} />
              <motion.div className="absolute inset-0 rounded-full border border-green-400/20" animate={{ scale: [1, 1.5], opacity: [0.3, 0] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut', delay: 0.3 }} />
              <div className="absolute inset-0 rounded-full border border-green-400/10 flex items-center justify-center">{phaseIcon(progressPhase)}</div>
            </>
          ) : (
            <>
              <motion.div className="absolute inset-0 rounded-full border border-white/20" animate={{ scale: [1, 1.8], opacity: [0.4, 0] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }} />
              <motion.div className="absolute inset-0 rounded-full border border-white/15" animate={{ scale: [1, 1.5], opacity: [0.3, 0] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeOut', delay: 0.5 }} />
              <div className="absolute inset-0 rounded-full border border-white/10 flex items-center justify-center">{phaseIcon(progressPhase)}</div>
            </>
          )}
        </div>
        <p className="t-body text-gray-400 tracking-wide">{progressText || 'Generating…'}</p>
        {progress > 0 && (
          <div className="w-56 h-1 bg-white/10 rounded-full overflow-hidden">
            <motion.div className="h-full rounded-full bg-lu-accent" initial={{ width: 0 }} animate={{ width: `${Math.min(progress, 100)}%` }} transition={{ duration: 0.3 }} />
          </div>
        )}
      </div>
    </div>
  )
}

interface ResultProps {
  item: GalleryItem
  onFullscreen: () => void
  onSendToEditor?: () => void
}

export function ResultView({ item, onFullscreen, onSendToEditor }: ResultProps) {
  const url = galleryItemUrl(item)
  // Desktop build: every gallery item is a ComfyUI output (dataUrl was the
  // MLX path, remoteUrl the cloud path — both web-only). downloadComfyFile
  // goes through the native Save-As dialog, which WebView2 blob-anchors can't.
  const download = () => downloadComfyFile(item.filename, item.subfolder)
  const isVideo = item.type === 'video'
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 min-h-0">
      <div className="relative group max-w-full max-h-full">
        {isVideo ? (
          <video
            src={url}
            controls
            loop
            autoPlay
            muted
            className="max-w-full max-h-[62vh] object-contain rounded-[var(--radius-panel)] border border-white/[0.06]"
          />
        ) : (
          <img
            src={url}
            alt={item.prompt}
            className={cn('max-w-full max-h-[62vh] object-contain rounded-[var(--radius-panel)] border border-white/[0.06]', item.intent === 'removebg' && 'lu-checker')}
          />
        )}
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onSendToEditor && !isVideo && (
            <IconBtn title="Edit with mask" onClick={onSendToEditor}><Wand2 size={14} /></IconBtn>
          )}
          <IconBtn title="Download" onClick={download}><Download size={14} /></IconBtn>
          <IconBtn title="Fullscreen" onClick={onFullscreen}><Maximize2 size={14} /></IconBtn>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-3 t-mono text-gray-600">
        <span>{item.width}×{item.height}</span>
        <span>·</span>
        <span>seed {item.seed}</span>
        <span>·</span>
        <span className="truncate max-w-[280px]">{prettyModel(item.model)}</span>
      </div>
    </div>
  )
}

function IconBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={title} className="w-7 h-7 flex items-center justify-center rounded-lg bg-black/50 backdrop-blur text-gray-200 hover:text-white hover:bg-black/70 transition-colors">
      {children}
    </button>
  )
}

function prettyModel(f: string): string { return f.replace(/\.(safetensors|ckpt|pt)$/i, '').replace(/[_]+/g, ' ') }
