import { useCreateStore } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { intentToJob } from '../../../lib/render/cloud-jobs'
import { defaultCloudModel, runCredits } from '../../../stores/cloudCatalogStore'
import { Tooltip } from '../ui/Tooltip'
import { openExternal } from '../../../api/backend'
import { CLOUD_BASE } from '../../../api/cloud/config'
import { cn } from '../ui/cn'

// Compact credits meter for the cloud backend: remaining vs monthly budget,
// plus the cost of the run the user is about to start. One shared pool —
// images and clips draw from the same number. At 0 (or not enough for this
// run) it becomes the upsell chip and the Create button is gated off.
export function CreditsMeter() {
  const { quota } = useCreateExp()
  const intent = useCreateStore((s) => s.intent())
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  const frames = useCreateStore((s) => s.frames)
  const fps = useCreateStore((s) => s.fps)
  const targetResolution = useCreateStore((s) => s.targetResolution)
  if (!quota) return null

  const { kind, op } = intentToJob(intent)
  // Price the exact run the user is about to make — model, op, (for video)
  // clip length and (for upscale) target resolution — not the tier's
  // representative per-kind figure; utility ops and pricier models would
  // otherwise show a wrong number and mis-gate the button. Same figure
  // Composer's creditsOk gates on.
  const picked = (kind === 'video' ? cloudVideoModel : cloudImageModel) || defaultCloudModel(kind).id
  const seconds =
    kind === 'video' && (op === 'generate' || op === 'animate') && fps > 0 ? frames / fps : undefined
  const cost = runCredits(kind, op, picked, seconds, quota.costs[kind], targetResolution)
  const remaining = quota.remaining.credits
  const limit = quota.limits.credits
  const enough = remaining >= cost
  const pct = limit > 0 ? Math.max(0, Math.min(1, remaining / limit)) : 0

  if (!enough) {
    return (
      <button
        onClick={() => void openExternal(`${CLOUD_BASE}/pricing`)}
        className="t-control px-2 h-[var(--control-h-sm)] inline-flex items-center rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors"
      >
        {remaining <= 0 ? 'Out of credits, upgrade' : `Needs ${cost} credits (${remaining} left)`}
      </button>
    )
  }

  return (
    <Tooltip
      content={`${remaining} of ${limit} credits left this month. This ${kind === 'video' ? 'clip' : 'image'} uses ${cost}.`}
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
