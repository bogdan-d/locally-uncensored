
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight, HelpCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

interface Props {
  title: string
  icon?: LucideIcon
  help?: string
  collapsible?: boolean
  defaultOpen?: boolean
  right?: React.ReactNode
  children: React.ReactNode
}

export function Section({ title, icon: Icon, help, collapsible = true, defaultOpen = true, right, children }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const toggle = () => collapsible && setOpen((o) => !o)

  return (
    <div className="border-b border-white/[0.05] last:border-b-0">
      <div className="flex items-center justify-between py-2.5">
        <button onClick={toggle} className={cn('flex items-center gap-1.5 group', !collapsible && 'cursor-default')}>
          {collapsible && (
            <ChevronRight size={13} className={cn('text-gray-600 transition-transform', open && 'rotate-90')} />
          )}
          {Icon && <Icon size={13} className="text-gray-500" />}
          <span className="t-label text-gray-400 group-hover:text-gray-300">{title}</span>
          {help && (
            <Tooltip content={help}>
              <HelpCircle size={12} className="text-gray-600 hover:text-gray-400" />
            </Tooltip>
          )}
        </button>
        {right}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="pb-3 space-y-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}