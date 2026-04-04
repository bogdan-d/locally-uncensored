import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowDownToLine, Pause, Play, X, CheckCircle } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { formatBytes } from '../../lib/formatters'

function ProgressBar({ progress }: { progress: number }) {
  return (
    <div className="w-full h-1 rounded-full bg-white/[0.06] overflow-hidden">
      <div className="h-full rounded-full bg-blue-500 transition-all duration-300" style={{ width: `${Math.min(100, progress)}%` }} />
    </div>
  )
}

export function DownloadBadge() {
  const { activePulls, pullModel, pausePull, dismissPull } = useModels()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const entries = Object.entries(activePulls)
  const activeCount = entries.filter(([, s]) => !s.paused && !s.complete).length
  const hasAny = entries.length > 0

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Auto-open when a new download starts
  useEffect(() => {
    if (activeCount > 0) setOpen(true)
  }, [activeCount])

  return (
    <div ref={ref} className="relative">
      {/* Icon button */}
      <button
        onClick={() => setOpen(!open)}
        className={`relative p-1.5 rounded-md transition-colors ${
          hasAny
            ? 'text-blue-400 hover:bg-blue-500/10'
            : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5'
        }`}
        title="Downloads"
      >
        <ArrowDownToLine size={14} />
        {/* Badge */}
        {activeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-blue-500 text-[0.5rem] font-bold text-white leading-none px-0.5">
            {activeCount}
            <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-40" />
          </span>
        )}
        {/* Paused indicator (yellow dot, no ping) */}
        {activeCount === 0 && entries.some(([, s]) => s.paused) && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-yellow-500" />
        )}
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute right-0 top-full mt-1.5 w-72 rounded-lg overflow-hidden z-50 bg-white dark:bg-[#0f0f0f] border border-gray-200 dark:border-white/[0.06] shadow-2xl shadow-black/50"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
              <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-gray-500">
                Downloads {hasAny && `(${entries.length})`}
              </span>
              {entries.some(([, s]) => s.complete) && (
                <button
                  onClick={() => entries.filter(([, s]) => s.complete).forEach(([n]) => dismissPull(n))}
                  className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Clear completed
                </button>
              )}
            </div>

            {/* Download list */}
            <div className="max-h-[300px] overflow-y-auto">
              {entries.length === 0 && (
                <p className="text-center text-[0.7rem] text-gray-500 py-6">No active downloads</p>
              )}

              {entries.map(([name, state]) => {
                const prog = state.progress.total && state.progress.completed
                  ? (state.progress.completed / state.progress.total) * 100 : 0

                return (
                  <div key={name} className="px-3 py-2 border-t border-gray-100 dark:border-white/[0.04] first:border-t-0">
                    {/* Top row: name + controls */}
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-[0.7rem] font-mono text-gray-700 dark:text-gray-300 truncate">{name}</p>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {/* Pause */}
                        {!state.complete && !state.paused && (
                          <button
                            onClick={() => pausePull(name)}
                            className="p-0.5 rounded hover:bg-yellow-500/20 text-gray-400 hover:text-yellow-400 transition-colors"
                            title="Pause"
                          >
                            <Pause size={11} />
                          </button>
                        )}
                        {/* Resume */}
                        {state.paused && (
                          <button
                            onClick={() => pullModel(name)}
                            className="p-0.5 rounded hover:bg-green-500/20 text-gray-400 hover:text-green-400 transition-colors"
                            title="Resume"
                          >
                            <Play size={11} />
                          </button>
                        )}
                        {/* Dismiss */}
                        <button
                          onClick={() => dismissPull(name)}
                          className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors"
                          title="Dismiss"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    </div>

                    {/* Status */}
                    {state.complete ? (
                      <div className="flex items-center gap-1.5 text-green-400">
                        <CheckCircle size={11} />
                        <span className="text-[0.65rem]">Complete</span>
                      </div>
                    ) : state.paused ? (
                      <span className="text-[0.65rem] text-yellow-400">Paused — click ▶ to resume</span>
                    ) : (
                      <>
                        <p className="text-[0.6rem] text-gray-500 mb-1 truncate">{state.progress.status}</p>
                        {state.progress.total && state.progress.completed !== undefined && (
                          <>
                            <ProgressBar progress={prog} />
                            <p className="text-[0.55rem] text-gray-500 mt-0.5">
                              {formatBytes(state.progress.completed || 0)} / {formatBytes(state.progress.total)}
                              {prog > 0 && <span className="ml-1.5 text-blue-400">{Math.round(prog)}%</span>}
                            </p>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
