
import { useRef, useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Check, Search } from 'lucide-react'
import { cn } from './cn'
import { useClickAway } from './useClickAway'

export interface SelectOption {
  value: string
  label: string
  sublabel?: string
  badge?: { label: string; color: string }
}

interface Props {
  options: SelectOption[]
  value: string
  onChange: (v: string) => void
  searchable?: boolean
  placeholder?: string
  size?: 'sm' | 'md'
  align?: 'left' | 'right'
  className?: string
  maxHeight?: number
}

export function Select({ options, value, onChange, searchable = false, placeholder = 'Select…', size = 'md', align = 'left', className, maxHeight = 280 }: Props) {
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)

  // Open upward when there isn't room below (e.g. the model chip in the
  // bottom composer bar) so the list never clips off the viewport.
  const toggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setDropUp(window.innerHeight - rect.bottom < maxHeight + 64)
    }
    setOpen((o) => !o)
  }

  const current = options.find((o) => o.value === value)
  const filtered = useMemo(() => {
    if (!query.trim()) return options
    const q = query.toLowerCase()
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.sublabel?.toLowerCase().includes(q))
  }, [options, query])

  const h = size === 'sm' ? 'h-[var(--control-h-sm)]' : 'h-[var(--control-h-md)]'

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          't-control inline-flex items-center justify-between gap-2 w-full px-2.5 rounded-[var(--radius-control)] transition-colors lu-focus-ring',
          'bg-white/[0.04] border border-white/[0.08] hover:border-white/15 text-gray-200',
          h,
        )}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {current?.badge && <Badge color={current.badge.color} label={current.badge.label} />}
          <span className="truncate">{current?.label ?? placeholder}</span>
        </span>
        <ChevronDown size={13} className={cn('shrink-0 text-gray-500 transition-transform', open && 'rotate-180')} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className={cn(
              'lu-elevated absolute z-50 min-w-full rounded-[var(--radius-panel)] p-1 overflow-hidden',
              dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
              align === 'right' ? 'right-0' : 'left-0',
            )}
          >
            {searchable && (
              <div className="flex items-center gap-1.5 px-2 py-1.5 mb-1 border-b border-white/[0.06]">
                <Search size={13} className="text-gray-500" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  className="t-control bg-transparent outline-none w-full text-gray-200 placeholder-gray-600"
                />
              </div>
            )}
            <div className="overflow-y-auto scrollbar-thin" style={{ maxHeight }}>
              {filtered.length === 0 && <div className="t-control text-gray-600 px-2.5 py-2">No matches</div>}
              {filtered.map((o) => {
                const selected = o.value === value
                return (
                  <button
                    key={o.value}
                    onClick={() => { onChange(o.value); setOpen(false); setQuery('') }}
                    className={cn(
                      't-control w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[6px] text-left transition-colors',
                      selected ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/[0.06]',
                    )}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      {o.badge && <Badge color={o.badge.color} label={o.badge.label} />}
                      <span className="truncate">{o.label}</span>
                      {o.sublabel && <span className="t-mono text-gray-600 truncate">{o.sublabel}</span>}
                    </span>
                    {selected && <Check size={13} className="shrink-0 text-gray-300" />}
                  </button>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Badge({ color, label }: { color: string; label: string }) {
  return <span className={cn('px-1.5 py-0.5 rounded text-[0.55rem] font-semibold shrink-0', color)}>{label}</span>
}