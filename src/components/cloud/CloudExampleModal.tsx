// Example video popup (2.5.8): the step between a teaser sheet's "See plans"
// and the CloudGateModal. Shows a short looping clip of the tool actually
// doing its thing (real footage from recorded cloud runs, produced by
// scripts/teasers and shipped in public/teasers/<intent>.webm with a webp
// poster). Only intent surfaces have clips; model-row teasers keep the
// direct path to the gate. A missing or broken asset skips straight to the
// gate so the flow never dead-ends on a black box.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Cloud, Sparkles, Volume2, VolumeX } from 'lucide-react'
import { useUIStore, type CloudTeaserTarget } from '../../stores/uiStore'

type ExampleIntent = Extract<CloudTeaserTarget, { surface: 'intent' }>['intent']

const TITLES: Record<ExampleIntent, string> = {
  upscale: 'Upscale',
  eraser: 'Erase Object',
  character: 'Character Studio',
  lipsync: 'Talking Character',
  music: 'Music',
  extend: 'Extend Video',
  motion: 'Motion Control',
}

export function CloudExampleModal() {
  const target = useUIStore((s) => s.cloudExampleVideo)
  const setTarget = useUIStore((s) => s.setCloudExampleVideo)
  const setCloudGateOpen = useUIStore((s) => s.setCloudGateOpen)
  // The music clip carries the generated track; it still starts muted
  // (autoplay policy + not startling anyone) with a tap-to-listen toggle.
  const [muted, setMuted] = useState(true)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => { setMuted(true) }, [target?.intent])
  // React's `muted` attribute is unreliable on re-renders; set the property.
  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted }, [muted, target])

  const close = () => setTarget(null)
  const toPlans = () => { setTarget(null); setCloudGateOpen(true) }

  return (
    <AnimatePresence>
      {target && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={close}
        >
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
            className="w-[440px] max-w-[94vw] rounded-2xl bg-[#232323] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden"
          >
            {/* Clip stage: 16:9, poster paints instantly, clip loops. */}
            <div className="relative aspect-video bg-[#1b1b1b] border-b border-white/[0.06]">
              <video
                ref={videoRef}
                key={target.intent}
                className="w-full h-full object-cover"
                src={`/teasers/${target.intent}.webm`}
                poster={`/teasers/${target.intent}-poster.webp`}
                autoPlay
                muted
                loop
                playsInline
                onError={toPlans}
              />
              <button
                onClick={close}
                className="absolute top-2 right-2 p-1.5 rounded-md text-gray-400 hover:text-gray-100 bg-black/30 hover:bg-black/50 transition-colors"
                title="Close"
                aria-label="Close"
              >
                <X size={14} />
              </button>
              {target.intent === 'music' && (
                <button
                  onClick={() => setMuted((m) => !m)}
                  className="absolute bottom-2 right-2 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[0.62rem] text-gray-200 bg-black/40 hover:bg-black/60 transition-colors"
                  aria-label={muted ? 'Unmute' : 'Mute'}
                >
                  {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                  {muted ? 'Hear it' : 'Mute'}
                </button>
              )}
            </div>

            <div className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                {/* Panel is fixed dark in both themes, so always use the dark
                    tints; arbitrary text color dodges the `.light .text-white`
                    remap (same rule as ModelTiles). */}
                <Cloud size={14} className="text-violet-300" />
                <h3 className="text-[0.85rem] font-semibold text-[#fafafa]">{TITLES[target.intent]}</h3>
                <span className="ml-auto text-[0.55rem] font-medium uppercase tracking-widest text-violet-300/80">
                  LU Cloud
                </span>
              </div>
              <p className="text-[0.68rem] leading-relaxed text-gray-400">
                Real output, straight from LU Cloud. This is what the tool makes.
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={toPlans}
                  className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg bg-white text-black text-[0.7rem] font-semibold hover:bg-gray-200 transition-colors"
                >
                  <Sparkles size={12} /> See plans
                </button>
                <button
                  onClick={close}
                  className="px-3 h-8 rounded-lg text-[0.7rem] text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors"
                >
                  Not now
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
