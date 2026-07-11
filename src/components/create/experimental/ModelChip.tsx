import { useCreateStore } from '../../../stores/createStore'
import { useCloudCatalogStore, defaultCloudModel, defaultEditModel, isEditCapable } from '../../../stores/cloudCatalogStore'
import { Select, type SelectOption } from '../ui/Select'
import { TYPE_BADGE } from './badges'

const CLOUD_BADGE = { label: 'Cloud', color: 'bg-violet-500/15 text-violet-300' }

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
  const setCloudImageModel = useCreateStore((s) => s.setCloudImageModel)
  const setCloudVideoModel = useCreateStore((s) => s.setCloudVideoModel)
  const models = useCloudCatalogStore((s) => s.models)

  const isVideo = mode === 'video'
  const kind = isVideo ? 'video' : 'image'
  // Edit needs a masked-img2img model (flux-dev today). Only offer the models
  // that can actually do it — otherwise the picker lists t2i-only checkpoints
  // that useCloudCreate silently swaps out at submit, so the user's choice was
  // a lie. (Video: every catalog clip model is t2v+i2v, so no per-op filter.)
  const editOnly = intent === 'edit'
  const list = models.filter((m) => m.kind === kind && (!editOnly || m.edit))
  const current = (isVideo ? cloudVideoModel : cloudImageModel) || defaultCloudModel(kind)?.id || ''
  // Reflect the model the run will really use, so a t2i model left over from
  // the Image tab doesn't show as "selected" on an edit it can't perform.
  const value = editOnly && !isEditCapable(current) ? (defaultEditModel()?.id ?? current) : current

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
      onChange={(v) => (isVideo ? setCloudVideoModel(v) : setCloudImageModel(v))}
    />
  )
}

function LocalModelChip() {
  const mode = useCreateStore((s) => s.mode)
  const imageModel = useCreateStore((s) => s.imageModel)
  const videoModel = useCreateStore((s) => s.videoModel)
  const imageModelList = useCreateStore((s) => s.imageModelList)
  const videoModelList = useCreateStore((s) => s.videoModelList)
  const setImageModel = useCreateStore((s) => s.setImageModel)
  const setVideoModel = useCreateStore((s) => s.setVideoModel)

  const isVideo = mode === 'video'

  const list = isVideo ? videoModelList : imageModelList
  const value = isVideo ? videoModel : imageModel

  const options: SelectOption[] = list.map((m) => ({
    value: m.name,
    label: prettyName(m.name),
    badge: TYPE_BADGE[m.type],
  }))

  return (
    <Select
      size="sm"
      searchable
      align="right"
      className="min-w-[150px] max-w-[230px]"
      options={options}
      value={value}
      onChange={(v) => {
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
