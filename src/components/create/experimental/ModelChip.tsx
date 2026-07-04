import { useCreateStore } from '../../../stores/createStore'
import { Select, type SelectOption } from '../ui/Select'
import { TYPE_BADGE } from './badges'

// Badge-aware model picker (replaces the raw <select>). Desktop build: only
// the locally installed checkpoints — the web app's hosted-catalog branch
// (backend === 'cloud') does not exist here.
export function ModelChip() {
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
