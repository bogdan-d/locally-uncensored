import { useCallback, useEffect, useRef, useState } from 'react'
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
import { VhsInstallModal } from './VhsInstallModal'
import { INTENT_MAP } from './intents'
import { fetchGalleryItemBlob } from './galleryUrl'
import { loadImageRef } from './loadImage'

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
  const backend = useCreateStore((s) => s.backend)
  const { modelLoadError, connected, comfyOnCpu } = useCreateExp()

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

  // Pull a finished result back in as the working source (ImageRef). Needed
  // because a text-to-image run leaves `source` empty — without this, "Edit
  // with mask" on a result and switching to Edit/Upscale/Eraser/Animate were
  // no-ops that demanded a download + re-upload of the app's own output.
  const adoptResult = useCallback(async (item: GalleryItem) => {
    const blob = await fetchGalleryItemBlob(item)
    const file = new File([blob], item.filename || 'result.png', { type: blob.type || 'image/png' })
    return loadImageRef(file)
  }, [])

  const editResultWithMask = useCallback(async (item: GalleryItem) => {
    useCreateStore.getState().setIntent('edit')
    try {
      useCreateStore.getState().setSource(await adoptResult(item))
      setMaskOpen(true)
    } catch (err) {
      setError(`Could not load the result for editing: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [adoptResult, setError])

  // David 2026-07-10: source-needing ops must start EMPTY — never silently
  // adopt a gallery image as the input. Adoption is always explicit: the
  // InputSlot's "pick from gallery" strip, drag&drop, the file picker, or a
  // result's "Edit" action. While an op intent owns the stage, clicking a
  // gallery tile opens the Lightbox (view it, videos play) instead of
  // pinning into a stage that can't display it.
  const intent = useCreateStore((s) => s.intent())
  const openGalleryItem = useCallback((id: string) => {
    const item = useCreateStore.getState().gallery.find((g) => g.id === id)
    if (!item) return
    if (INTENT_MAP[intent].needsSource) setLightbox(item)
    else setPinnedId(id)
  }, [intent])

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

      {/* CPU-mode warning — persistent while LU's ComfyUI runs with --cpu.
          Without it an AMD/non-NVIDIA user sees "Ready to generate" and then
          a bare 20-minute timeout (shd_scorpion, RX 7900 XTX). Local renders
          only — cloud jobs never touch the local ComfyUI. */}
      {backend === 'local' && connected === true && comfyOnCpu && (
        <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/5 border-b border-yellow-500/10 text-yellow-300 text-xs shrink-0">
          <AlertTriangle size={12} className="shrink-0" />
          <span>
            ComfyUI is running on the CPU (no usable GPU detected) — generation will be extremely slow and may time out.
            AMD GPU? Point LU at a ROCm/ZLUDA ComfyUI and set Settings → Hardware → ComfyUI GPU to force GPU.
          </span>
        </div>
      )}

      {/* Stage + Composer + right Advanced drawer share one relative container */}
      <div className="flex-1 min-h-0 relative flex flex-col">
        <Stage
          displayed={displayed}
          onOpenMaskEditor={() => setMaskOpen(true)}
          onEditResult={(it) => { void editResultWithMask(it) }}
          onFullscreen={(it) => setLightbox(it)}
        />
        <GalleryStrip activeId={pinnedId} onSelect={openGalleryItem} />
        <Composer onOpenAdvanced={() => setAdvancedOpen(true)} />

        <AdvancedDrawer open={advancedOpen} onClose={() => setAdvancedOpen(false)} />
        <MaskEditor open={maskOpen} onClose={() => setMaskOpen(false)} />
      </div>

      <Lightbox item={lightbox} onClose={() => setLightbox(null)} />
      <VhsInstallModal />
    </div>
  )
}
