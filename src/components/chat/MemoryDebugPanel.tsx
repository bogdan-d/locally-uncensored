import { useState, useEffect } from 'react'
import { Brain, ChevronDown, X, Archive } from 'lucide-react'
import { useMemoryStore } from '../../stores/memoryStore'
import { useModelStore } from '../../stores/modelStore'
import { getModelMaxTokens } from '../../lib/context-compaction'
import { AnimatePresence, motion } from 'framer-motion'

export function MemoryDebugToggle() {
  const [open, setOpen] = useState(false)
  const entryCount = useMemoryStore((s) => s.entries.length)

  if (entryCount === 0) return null

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className={
          'flex items-center gap-1.5 px-3 py-1 rounded-full border transition-colors text-xs ' +
          (open
            ? 'border-purple-400 dark:border-purple-500/40 text-purple-600 dark:text-purple-300'
            : 'border-gray-300 dark:border-white/15 hover:border-gray-400 dark:hover:border-white/25 text-gray-500 dark:text-gray-400')
        }
        title="Memory — see which memories are active"
      >
        <Brain size={13} />
        <span className="font-medium">Memory</span>
        <span className="min-w-[16px] h-[16px] flex items-center justify-center rounded-full text-[0.55rem] font-bold bg-gray-200 dark:bg-white/15 text-gray-600 dark:text-gray-300">
          {entryCount}
        </span>
      </button>

      <AnimatePresence>
        {open && <MemoryDebugPopover onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  )
}

function MemoryDebugPopover({ onClose }: { onClose: () => void }) {
  const entries = useMemoryStore((s) => s.entries)
  const activeModel = useModelStore((s) => s.activeModel)
  const [injectedPreview, setInjectedPreview] = useState<string>('')

  // Load injected preview on mount — use the SAME embedding-first path the
  // chat hooks use so the preview matches what actually gets injected (it
  // falls back to keyword scoring offline).
  useEffect(() => {
    if (!activeModel) return
    let cancelled = false
    getModelMaxTokens(activeModel)
      .then((tokens) => useMemoryStore.getState().getMemoriesForPromptAsync('', tokens))
      .then((preview) => { if (!cancelled) setInjectedPreview(preview) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeModel])

  const typeColors: Record<string, string> = {
    user: 'text-blue-400',
    feedback: 'text-green-400',
    project: 'text-amber-400',
    reference: 'text-gray-400',
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -5 }}
      className="fixed inset-0 z-50 flex items-start justify-center pt-16"
      onClick={onClose}
    >
      <div
        className="w-[400px] max-h-[60vh] bg-white dark:bg-[#262626] border border-gray-200 dark:border-white/10 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-white/[0.06]">
          <div className="flex items-center gap-2">
            <Brain size={12} className="text-purple-400" />
            <span className="text-[0.65rem] font-semibold text-gray-700 dark:text-gray-300">Active Memories ({entries.length})</span>
          </div>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-white/10 text-gray-500">
            <X size={12} />
          </button>
        </div>

        {/* Memory list */}
        <div className="overflow-y-auto max-h-[40vh] scrollbar-thin">
          {entries.length === 0 ? (
            <p className="text-[0.6rem] text-gray-600 px-3 py-4 text-center">No memories stored yet.</p>
          ) : (
            entries.slice(0, 30).map((entry) => {
              const stale = entry.stale === true || typeof entry.supersededBy === 'string'
              return (
                <div key={entry.id} className={`px-3 py-1.5 border-b border-white/[0.03] hover:bg-white/[0.02] ${stale ? 'opacity-50' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[0.5rem] uppercase font-bold tracking-wider ${typeColors[entry.type] || 'text-gray-500'}`}>
                      {entry.type}
                    </span>
                    <span className="text-[0.6rem] text-gray-300 font-medium truncate">{entry.title}</span>
                    {stale && (
                      <span className="flex items-center gap-0.5 text-[0.45rem] uppercase tracking-wider text-gray-500 shrink-0" title="Outdated — not injected into prompts">
                        <Archive size={8} /> outdated
                      </span>
                    )}
                  </div>
                  <p className="text-[0.55rem] text-gray-600 truncate mt-0.5">{entry.content.substring(0, 120)}</p>
                </div>
              )
            })
          )}
        </div>

        {/* Injection preview */}
        {injectedPreview && (
          <div className="border-t border-white/[0.06] px-3 py-2">
            <div className="flex items-center gap-1 mb-1">
              <ChevronDown size={10} className="text-gray-600" />
              <span className="text-[0.5rem] uppercase tracking-wider text-gray-600 font-semibold">Injected into prompt</span>
            </div>
            <pre className="text-[0.5rem] text-gray-500 font-mono whitespace-pre-wrap max-h-24 overflow-y-auto scrollbar-thin leading-relaxed">
              {injectedPreview.substring(0, 800)}
            </pre>
          </div>
        )}
      </div>
    </motion.div>
  )
}
