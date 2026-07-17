import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Sparkles } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { runCredits } from '../../../stores/cloudCatalogStore'
import { useCreateExp } from './CreateContext'
import { useComfyMedia } from './useComfyMedia'
import { cn } from '../ui/cn'

export function Lightbox({ item, onClose }: { item: GalleryItem | null; onClose: () => void }) {
  const backend = useCreateStore((s) => s.backend)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const { enhanceVideo, quota } = useCreateExp()
  const { src: mediaUrl, onError: onMediaError } = useComfyMedia(item)

  useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, onClose])

  // Video super-resolution: only for finished CLOUD renders (jobId = the
  // clip lives in the user's render storage, which the enhance op requires).
  const canEnhance = item?.type === 'video' && !!item.jobId && backend === 'cloud' && !isGenerating
  // Gate on the run's cost like the Composer does — Enhance is a paid action
  // too, and without the gate the only feedback was a server 429 after the
  // progress bar had already started. Clip length is unknown client-side, so
  // runCredits mirrors the server's 8 s default.
  const enhanceCredits =
    canEnhance && quota != null
      ? runCredits('video', 'upscale', item.model || '', undefined, quota.costs.video)
      : null
  const enhanceOk = enhanceCredits !== null && quota != null && quota.remaining.credits >= enhanceCredits

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-[80] bg-black/85 flex items-center justify-center p-8"
        >
          <button onClick={onClose} className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-lg bg-white/10 text-gray-200 hover:bg-white/20">
            <X size={18} />
          </button>
          {canEnhance && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (!enhanceOk) return
                onClose()
                void enhanceVideo(item)
              }}
              disabled={!enhanceOk}
              title={
                enhanceOk
                  ? 'Upscale this clip to 1080p on the cloud fleet'
                  : 'Not enough credits left this month for a video enhance'
              }
              className={cn(
                'absolute top-4 right-16 h-9 px-3 flex items-center gap-1.5 rounded-lg text-[0.7rem] font-medium',
                enhanceOk ? 'bg-white/10 text-gray-200 hover:bg-white/20' : 'bg-white/5 text-gray-500 cursor-not-allowed',
              )}
            >
              <Sparkles size={13} /> Enhance
            </button>
          )}
          {item.type === 'audio' ? (
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              onClick={(e) => e.stopPropagation()}
              className="w-[480px] max-w-[90vw] flex flex-col items-center gap-4 p-8 rounded-lg bg-white/[0.04] border border-white/[0.08]"
            >
              {item.prompt && <p className="t-body text-gray-300 text-center">{item.prompt}</p>}
              <audio src={mediaUrl} controls autoPlay onError={onMediaError} className="w-full" />
            </motion.div>
          ) : item.type === 'video' ? (
            <motion.video
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              src={mediaUrl}
              controls
              autoPlay
              loop
              onError={onMediaError}
              onClick={(e) => e.stopPropagation()}
              className="max-w-full max-h-full object-contain rounded-lg"
            />
          ) : (
            <motion.img
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              src={mediaUrl}
              alt={item.prompt}
              onError={onMediaError}
              onClick={(e) => e.stopPropagation()}
              className={cn('max-w-full max-h-full object-contain rounded-lg', item.intent === 'removebg' && 'lu-checker')}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
