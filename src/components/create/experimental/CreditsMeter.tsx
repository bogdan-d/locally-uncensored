import { useCreateStore } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { intentToJob } from '../../../lib/render/cloud-jobs'
import { Tooltip } from '../ui/Tooltip'
import { cn } from '../ui/cn'

// Compact credits meter for the cloud backend: remaining vs monthly budget,
// plus the cost of the run the user is about to start. One shared pool —
// images and clips draw from the same number. At 0 (or not enough for this
// run) it becomes the upsell chip and the Create button is gated off.
export function CreditsMeter() {
  const { quota } = useCreateExp()
  const intent = useCreateStore((s) => s.intent())
  if (!quota) return null

  const { kind } = intentToJob(intent)
  const cost = quota.costs[kind]
  const remaining = quota.remaining.credits
  const limit = quota.limits.credits
  const enough = remaining >= cost
  const pct = limit > 0 ? Math.max(0, Math.min(1, remaining / limit)) : 0

  if (!enough) {
    return (
      <a
        href="/pricing"
        className="t-control px-2 h-[var(--control-h-sm)] inline-flex items-center rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors"
      >
        {remaining <= 0 ? 'Out of credits — upgrade' : `Needs ${cost} credits (${remaining} left)`}
      </a>
    )
  }

  return (
    <Tooltip
      content={`${remaining} of ${limit} credits left this month — this ${kind === 'video' ? 'clip' : 'image'} uses ${cost}.`}
    >
      <div className="flex items-center gap-1.5 px-2 h-[var(--control-h-sm)] rounded-md bg-white/[0.04] text-gray-400 t-control">
        <div className="w-12 h-1 rounded-full bg-white/10 overflow-hidden">
          <div
            className={cn('h-full rounded-full', pct > 0.25 ? 'bg-emerald-400/80' : 'bg-amber-400/80')}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
        <span className="tabular-nums">{remaining}</span>
      </div>
    </Tooltip>
  )
}
