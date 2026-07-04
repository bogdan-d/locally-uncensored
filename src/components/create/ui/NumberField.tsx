import { Dices } from 'lucide-react'
import { cn } from './cn'

interface Props {
  label?: string
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  onRandomize?: () => void
  mono?: boolean
  suffix?: string
  className?: string
}

export function NumberField({ label, value, min, max, step = 1, onChange, onRandomize, mono = true, suffix, className }: Props) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label !== undefined && <div className="t-control text-gray-400">{label}</div>}
      <div className="flex items-center gap-1.5">
        <div className="flex items-center flex-1 h-[var(--control-h-md)] px-2.5 rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.08] focus-within:border-white/20">
          <input
            type="number"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v) }}
            className={cn('bg-transparent outline-none w-full t-control text-gray-200', mono && 'lu-hud-num')}
          />
          {suffix && <span className="t-mono text-gray-600 shrink-0 pl-1">{suffix}</span>}
        </div>
        {onRandomize && (
          <button
            onClick={onRandomize}
            title="Randomize"
            className="h-[var(--control-h-md)] aspect-square inline-flex items-center justify-center rounded-[var(--radius-control)] bg-white/[0.06] text-gray-400 hover:text-white hover:bg-white/10 transition-colors lu-focus-ring"
          >
            <Dices size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
