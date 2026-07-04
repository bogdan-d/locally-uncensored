import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, X } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { CreateExpProvider, useCreateExp } from './CreateContext'
import { IntentBar } from './IntentBar'
import { Stage } from './Stage'
import { Composer } from './Composer'
import { GalleryStrip } from './GalleryStrip'
import { Lightbox } from './Lightbox'
import { AdvancedDrawer } from './AdvancedDrawer'
import { MaskEditor } from './MaskEditor'

/** The redesigned Create surface. Mounted by AppShell for currentView==='create'. */
export function CreateExperimental() {
  return (
    <CreateExpProvider>
      <CreateExperimentalInner />
    </CreateExpProvider>
  )
}

function CreateExperimentalInner() {
  const gallery = useCreateStore((s) => s.gallery)
  const error = useCreateStore((s) => s.error)
  const setError = useCreateStore((s) => s.setError)
  const { modelLoadError } = useCreateExp()

  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [maskOpen, setMaskOpen] = useState(false)
  const [lightbox, setLightbox] = useState<GalleryItem | null>(null)

  // When a fresh generation lands on top, drop any pinned selection so the
  // newest result shows.
  const prevTop = useRef<string | undefined>(undefined)
  useEffect(() => {
    const top = gallery[0]?.id
    if (top && top !== prevTop.current) { setPinnedId(null); prevTop.current = top }
  }, [gallery])

  const displayed = (pinnedId ? gallery.find((g) => g.id === pinnedId) : undefined) ?? gallery[0]
  const banner = error ?? modelLoadError

  return (
    <div className="h-full w-full flex flex-col bg-[#141414] text-gray-200 overflow-hidden">
      <IntentBar />

      <AnimatePresence>
        {banner && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden shrink-0"
          >
            <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-red-200 t-body">
              <AlertTriangle size={14} className="shrink-0" />
              <span className="flex-1 min-w-0 truncate">{banner}</span>
              {error && (
                <button onClick={() => setError(null)} className="shrink-0 text-red-300/70 hover:text-red-100" title="Dismiss">
                  <X size={14} />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stage + Composer + right Advanced drawer share one relative container */}
      <div className="flex-1 min-h-0 relative flex flex-col">
        <Stage
          displayed={displayed}
          onOpenMaskEditor={() => setMaskOpen(true)}
          onFullscreen={(it) => setLightbox(it)}
        />
        <GalleryStrip activeId={pinnedId} onSelect={setPinnedId} />
        <Composer onOpenAdvanced={() => setAdvancedOpen(true)} />

        <AdvancedDrawer open={advancedOpen} onClose={() => setAdvancedOpen(false)} />
        <MaskEditor open={maskOpen} onClose={() => setMaskOpen(false)} />
      </div>

      <Lightbox item={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
