import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Hide the default title/X header so the dialog can render its own
   *  centered hero layout (a floating close button is still provided). */
  hideHeader?: boolean
  /** Tailwind max-width of the panel. Default `max-w-lg`. */
  maxWidth?: string
}

// A modal is a real dialog, so it needs an OPAQUE, elevated surface — not the
// transparent `.glass-card` (which is `background: transparent` for inline
// panels). Without this the dialog read straight through to whatever tab was
// behind it and the white title vanished on a light surface.
export function Modal({ open, onClose, title, children, hideHeader, maxWidth = 'max-w-lg' }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            className={
              'relative z-10 w-full rounded-2xl p-6 border border-gray-200 dark:border-white/10 ' +
              'bg-white dark:bg-[#161719] shadow-2xl shadow-black/30 ' + maxWidth
            }
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          >
            {hideHeader ? (
              <button
                onClick={onClose}
                className="absolute top-3 right-3 p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            ) : (
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
                <button
                  onClick={onClose}
                  className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
                  aria-label="Close"
                >
                  <X size={20} />
                </button>
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
