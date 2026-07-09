import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import type { GalleryItem } from '../../../stores/createStore'
import { galleryItemUrl } from './galleryUrl'
import { cn } from '../ui/cn'

export function Lightbox({ item, onClose }: { item: GalleryItem | null; onClose: () => void }) {
  useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, onClose])

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
          {item.type === 'video' ? (
            <motion.video
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              src={galleryItemUrl(item)}
              controls
              autoPlay
              loop
              onClick={(e) => e.stopPropagation()}
              className="max-w-full max-h-full object-contain rounded-lg"
            />
          ) : (
            <motion.img
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              src={galleryItemUrl(item)}
              alt={item.prompt}
              onClick={(e) => e.stopPropagation()}
              className={cn('max-w-full max-h-full object-contain rounded-lg', item.intent === 'removebg' && 'lu-checker')}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
