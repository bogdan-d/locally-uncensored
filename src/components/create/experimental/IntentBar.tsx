import { useCreateStore } from '../../../stores/createStore'
import { INTENTS } from './intents'
import { cn } from '../ui/cn'

// Pure-CSS expand: no Framer layout projection anywhere, so nothing can snap or
// jitter on settle. The label opens via a `max-width` transition (collapses
// reliably to 0 — unlike grid `0fr`, which keeps its min-content floor — and
// interpolates as a plain length, so it's always smooth). The active pill
// cross-fades via colour/shadow; neighbours slide on natural flex reflow.
const EASE = 'ease-[cubic-bezier(0.22,1,0.36,1)]'

export function IntentBar() {
  const intent = useCreateStore((s) => s.intent())
  const setIntent = useCreateStore((s) => s.setIntent)
  const backend = useCreateStore((s) => s.backend)
  // Utility intents (upscale/eraser) are hosted-only endpoints — hide them on
  // the local backend. setIntent's base already clears a stale utilityOp when
  // the mode flips back and the user picks any normal intent.
  const intents = INTENTS.filter((m) => !m.cloudOnly || backend === 'cloud')

  return (
    <div
      role="radiogroup"
      aria-label="Create mode"
      className="flex items-center justify-center gap-1 px-4 py-0.5"
      // Sized to sit just 9% larger than the QuickControls ratio bar below
      // (which runs at scale 0.7): 0.7 × 1.09 ≈ 0.763.
      style={{ transform: 'scale(0.763)', transformOrigin: 'center' }}
    >
      {intents.map((meta) => {
        const selected = intent === meta.id
        const Icon = meta.icon
        return (
          <button
            key={meta.id}
            role="radio"
            aria-checked={selected}
            aria-label={meta.label}
            title={meta.label}
            onClick={() => setIntent(meta.id)}
            className={cn(
              'flex items-center h-9 rounded-full border lu-focus-ring transition-[background-color,border-color,box-shadow,color] duration-200',
              EASE,
              selected
                ? 'bg-white/[0.11] border-white/20 shadow-sm text-white'
                : 'border-transparent text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]',
            )}
          >
            <span className="grid place-items-center w-9 h-9 shrink-0">
              <Icon size={16} strokeWidth={selected ? 2 : 1.75} />
            </span>
            <span
              className={cn(
                'overflow-hidden whitespace-nowrap min-w-0 t-control transition-[max-width,opacity,padding] duration-200',
                EASE,
                selected ? 'max-w-[150px] opacity-100 pl-1 pr-3.5' : 'max-w-0 opacity-0 px-0',
              )}
            >
              {meta.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
