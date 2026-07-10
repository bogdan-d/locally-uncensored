import { motion } from 'framer-motion'
import { Trash2, Play } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { galleryItemUrl, recoverGalleryUrl } from './galleryUrl'
import { cn } from '../ui/cn'

interface Props {
  activeId: string | null
  onSelect: (id: string) => void
}

export function GalleryStrip({ activeId, onSelect }: Props) {
  const gallery = useCreateStore((s) => s.gallery)
  const removeFromGallery = useCreateStore((s) => s.removeFromGallery)
  if (gallery.length === 0) return null

  return (
    <div className="shrink-0 border-t border-white/[0.05] px-4 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="t-label text-gray-600">Gallery</span>
        <span className="t-mono text-gray-700">{gallery.length}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto scrollbar-thin pb-1">
        {gallery.map((g) => (
          <motion.div
            key={g.id}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="relative group shrink-0"
          >
            <button
              onClick={() => onSelect(g.id)}
              className={cn(
                'w-14 h-14 rounded-lg overflow-hidden border-2 transition-colors relative',
                (activeId ?? gallery[0]?.id) === g.id ? 'border-white/60' : 'border-transparent hover:border-white/20',
                g.intent === 'removebg' && 'lu-checker',
              )}
            >
              {g.type === 'video' ? (
                <>
                  <video src={galleryItemUrl(g)} muted playsInline onError={() => recoverGalleryUrl(g)} className="w-full h-full object-cover" />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/20"><Play size={14} className="text-white/90" /></span>
                </>
              ) : (
                <img src={galleryItemUrl(g)} alt="" onError={() => recoverGalleryUrl(g)} className="w-full h-full object-cover" />
              )}
            </button>
            <button
              onClick={() => removeFromGallery(g.id)}
              className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/70 text-gray-300 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              title="Delete"
            >
              <Trash2 size={9} />
            </button>
          </motion.div>
        ))}
      </div>
    </div>
  )
}
