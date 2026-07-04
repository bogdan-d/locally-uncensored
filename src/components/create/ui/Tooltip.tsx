
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from './cn'

interface Props {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'bottom'
  delay?: number
  className?: string
}

export function Tooltip({ content, children, side = 'top', delay = 400, className }: Props) {
  const [show, setShow] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const open = () => { timer.current = setTimeout(() => setShow(true), delay) }
  const close = () => { if (timer.current) clearTimeout(timer.current); setShow(false) }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {children}
      <AnimatePresence>
        {show && (
          <motion.span
            initial={{ opacity: 0, y: side === 'top' ? 3 : -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: side === 'top' ? 3 : -3 }}
            transition={{ duration: 0.12 }}
            role="tooltip"
            className={cn(
              'lu-elevated pointer-events-none absolute z-[60] left-1/2 -translate-x-1/2 w-max max-w-[220px] px-2.5 py-1.5 rounded-lg t-body text-gray-200',
              side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
            )}
          >
            {content}
            <span
              className={cn(
                'absolute left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-lu-overlay border-white/[0.08]',
                side === 'top' ? 'top-full -mt-1 border-b border-r' : 'bottom-full -mb-1 border-t border-l',
              )}
            />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}