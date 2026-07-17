import { useCreateStore } from '../../../stores/createStore'
import { useCloudCatalogStore, defaultCloudModel } from '../../../stores/cloudCatalogStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useUIStore } from '../../../stores/uiStore'
import { Select, type SelectOption } from '../ui/Select'
import { TYPE_BADGE } from './badges'
import { isI2VModel, isT2VCapable } from '../../../api/comfyui'

const CLOUD_BADGE = { label: 'Cloud', color: 'bg-violet-500/15 text-violet-300' }

// Local-mode discovery (2.5.8): hosted models ride at the bottom of the local
// picker as teaser rows — picking one opens the Cloud sheet instead of
// changing the selection. Value prefix keeps them apart from real checkpoints.
const TEASER_PREFIX = 'lu-cloud-teaser:'
const TEASER_ROWS = 4

// Badge-aware model picker (replaces the raw <select>). Local backend lists
// the installed checkpoints; the cloud backend lists the hosted catalog
// (server-driven via cloudCatalogStore) and writes the cloud model slugs.
export function ModelChip() {
  const backend = useCreateStore((s) => s.backend)
  return backend === 'cloud' ? <CloudModelChip /> : <LocalModelChip />
}

function CloudModelChip() {
  const mode = useCreateStore((s) => s.mode)
  const intent = useCreateStore((s) => s.intent())
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const setCloudImageModel = useCreateStore((s) => s.setCloudImageModel)
  const setCloudVideoModel = useCreateStore((s) => s.setCloudVideoModel)
  const setCloudOpModel = useCreateStore((s) => s.setCloudOpModel)
  const models = useCloudCatalogStore((s) => s.models)

  const isVideo = mode === 'video'
  const kind = isVideo ? 'video' : 'image'
  // The 2.5.8 specialized intents pick from their op's own family (both
  // trainer kinds together for Character-Studio) and store into cloudOpModel.
  const special =
    intent === 'character' || intent === 'lipsync' || intent === 'music' ||
    intent === 'extend' || intent === 'motion'
  // List only the models that can run the current op — otherwise the picker
  // offers checkpoints that useCloudCreate silently swaps out at submit, so the
  // user's choice was a lie. Edit needs masked-img2img (flux-dev); Animate needs
  // i2v; Video needs t2v (absent flag = capable, so today's dual-capable fleet
  // lists in full, and a future t2v-only model that sets i2v:false is excluded).
  const list =
    intent === 'edit' ? models.filter((m) => m.kind === 'image' && m.edit)
    : intent === 'animate' ? models.filter((m) => m.kind === 'video' && m.i2v !== false)
    : intent === 'video' ? models.filter((m) => m.kind === 'video' && m.t2v !== false)
    : intent === 'character' ? models.filter((m) => m.ops?.includes('lora-train'))
    : intent === 'lipsync' ? models.filter((m) => m.ops?.includes('lipsync'))
    : intent === 'music' ? models.filter((m) => m.ops?.includes('music'))
    : intent === 'extend' ? models.filter((m) => m.ops?.includes('extend'))
    : intent === 'motion' ? models.filter((m) => m.ops?.includes('motion'))
    : models.filter((m) => m.kind === kind && !m.ops)
  const current = special
    ? cloudOpModel
    : (isVideo ? cloudVideoModel : cloudImageModel) || defaultCloudModel(kind)?.id || ''
  // Reflect the model the run will really use, so a leftover pick the current op
  // can't perform doesn't show as "selected".
  const value = list.some((m) => m.id === current) ? current : (list[0]?.id ?? current)

  const options: SelectOption[] = list.map((m) => ({
    value: m.id,
    label: m.label,
    badge: CLOUD_BADGE,
  }))

  return (
    <Select
      size="sm"
      searchable
      align="right"
      className="min-w-[150px] max-w-[230px]"
      options={options}
      value={value}
      onChange={(v) =>
        special ? setCloudOpModel(v) : isVideo ? setCloudVideoModel(v) : setCloudImageModel(v)
      }
    />
  )
}

function LocalModelChip() {
  const mode = useCreateStore((s) => s.mode)
  const intent = useCreateStore((s) => s.intent())
  const imageModel = useCreateStore((s) => s.imageModel)
  const videoModel = useCreateStore((s) => s.videoModel)
  const imageModelList = useCreateStore((s) => s.imageModelList)
  const videoModelList = useCreateStore((s) => s.videoModelList)
  const setImageModel = useCreateStore((s) => s.setImageModel)
  const setVideoModel = useCreateStore((s) => s.setVideoModel)
  const teasersEnabled = useSettingsStore((s) => s.settings.cloudTeasersEnabled)
  const setCloudTeaser = useUIStore((s) => s.setCloudTeaser)
  const catalogModels = useCloudCatalogStore((s) => s.models)

  const isVideo = mode === 'video'

  // Mirror the cloud picker's op-gating (David 2026-07-17: "only offer models
  // that can actually do it"): Animate lists i2v-capable local models, Video
  // lists t2v-capable ones (SVD/FramePack are i2v-only and drop out there).
  const rawList = isVideo ? videoModelList : imageModelList
  const list = !isVideo
    ? rawList
    : intent === 'animate'
      ? rawList.filter((m) => isI2VModel(m.name))
      : rawList.filter((m) => isT2VCapable(m.name))
  const stored = isVideo ? videoModel : imageModel
  // Reflect the model the run will really use — a leftover pick the current
  // op can't perform must not show as "selected".
  const value = list.some((m) => m.name === stored) ? stored : (list[0]?.name ?? stored)

  const options: SelectOption[] = list.map((m) => ({
    value: m.name,
    label: prettyName(m.name),
    badge: TYPE_BADGE[m.type],
  }))
  // Discovery rows: a few hosted models of this kind at the list's tail.
  // Picking one opens the Cloud sheet; the local selection stays untouched.
  if (teasersEnabled) {
    const kind = isVideo ? 'video' : 'image'
    for (const m of catalogModels.filter((c) => c.kind === kind && !c.ops).slice(0, TEASER_ROWS)) {
      options.push({ value: `${TEASER_PREFIX}${m.id}`, label: m.label, badge: CLOUD_BADGE })
    }
  }

  return (
    <Select
      size="sm"
      searchable
      align="right"
      className="min-w-[150px] max-w-[230px]"
      options={options}
      value={value}
      onChange={(v) => {
        if (v.startsWith(TEASER_PREFIX)) {
          setCloudTeaser({
            surface: 'create-model',
            kind: isVideo ? 'video' : 'image',
            modelId: v.slice(TEASER_PREFIX.length),
          })
          return
        }
        if (isVideo) setVideoModel(v)
        else {
          const m = list.find((x) => x.name === v)
          setImageModel(v, m?.type ?? 'unknown')
        }
      }}
    />
  )
}

function prettyName(filename: string): string {
  return filename.replace(/\.(safetensors|ckpt|pt|gguf)$/i, '').replace(/[_]+/g, ' ')
}
