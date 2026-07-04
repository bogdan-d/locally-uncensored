
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { cn } from './cn'
import { Button } from './Button'

interface Action {
  label: string
  onClick: () => void
  icon?: LucideIcon
  variant?: 'primary' | 'secondary' | 'ghost'
}

interface Props {
  icon: LucideIcon
  /** When set, renders this image (e.g. the LU monogram) instead of the icon. */
  logoSrc?: string
  title: string
  description?: string
  action?: Action
  secondaryAction?: Action
  children?: React.ReactNode
  tone?: 'neutral' | 'accent'
}

export function EmptyState({ icon: Icon, logoSrc, title, description, action, secondaryAction, children, tone = 'neutral' }: Props) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="max-w-sm space-y-4"
      >
        {logoSrc ? (
          <img src={logoSrc} alt="" className="mx-auto h-14 w-14 object-contain opacity-90 select-none" draggable={false} />
        ) : (
          <div className={cn(
            'mx-auto w-14 h-14 rounded-2xl flex items-center justify-center',
            tone === 'accent' ? 'bg-white/[0.06] text-gray-300' : 'bg-white/[0.04] text-gray-500',
          )}>
            <Icon size={24} strokeWidth={1.5} />
          </div>
        )}
        <div className="space-y-1.5">
          <div className="t-title text-gray-200">{title}</div>
          {description && <div className="t-body text-gray-500">{description}</div>}
        </div>
        {children}
        {(action || secondaryAction) && (
          <div className="flex items-center justify-center gap-2 pt-1">
            {action && <Button variant={action.variant ?? 'primary'} icon={action.icon} onClick={action.onClick}>{action.label}</Button>}
            {secondaryAction && <Button variant={secondaryAction.variant ?? 'ghost'} icon={secondaryAction.icon} onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>}
          </div>
        )}
      </motion.div>
    </div>
  )
}