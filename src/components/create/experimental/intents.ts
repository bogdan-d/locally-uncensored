import { Image as ImageIcon, Wand2, Scissors, Video, Film, Maximize2, Eraser } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CreateIntent } from '../../../stores/createStore'

export interface IntentMeta {
  id: CreateIntent
  label: string
  short: string
  icon: LucideIcon
  placeholder: string
  needsSource: boolean
  needsPrompt: boolean
  allowsMask: boolean
  isVideo: boolean
  /** Capability id (custom-node bundle) this intent depends on, if any. */
  capability?: 'rmbg'
  /** Single-purpose hosted endpoints — only offered on the cloud backend. */
  cloudOnly?: true
  examples: string[]
}

export const INTENTS: IntentMeta[] = [
  {
    id: 'image', label: 'Image', short: 'Image', icon: ImageIcon,
    placeholder: 'Describe your image…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: false,
    examples: [
      'a lighthouse at dusk, dramatic storm clouds, cinematic',
      'a neon-lit alley in the rain, reflections, moody',
      'a cozy reading nook by a window, warm morning light',
    ],
  },
  {
    id: 'edit', label: 'Edit Image', short: 'Edit', icon: Wand2,
    placeholder: 'Describe the edit — what should change in the painted area…',
    needsSource: true, needsPrompt: true, allowsMask: true, isVideo: false,
    examples: ['replace the sky with a starry night', 'add a leather jacket', 'remove the person on the left'],
  },
  {
    id: 'removebg', label: 'Remove Background', short: 'Cutout', icon: Scissors,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: false, isVideo: false,
    capability: 'rmbg',
    examples: [],
  },
  {
    id: 'upscale', label: 'Upscale', short: 'Upscale', icon: Maximize2,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: false, isVideo: false,
    cloudOnly: true,
    examples: [],
  },
  {
    id: 'eraser', label: 'Erase Object', short: 'Erase', icon: Eraser,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: true, isVideo: false,
    cloudOnly: true,
    examples: [],
  },
  {
    id: 'video', label: 'Video', short: 'Video', icon: Video,
    placeholder: 'Describe the motion and the scene…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: true,
    examples: ['a slow-motion wave breaking on rocks, cinematic', 'timelapse of clouds over a mountain range'],
  },
  {
    id: 'animate', label: 'Animate Image', short: 'Animate', icon: Film,
    placeholder: 'Describe how the image should move…',
    needsSource: true, needsPrompt: true, allowsMask: false, isVideo: true,
    examples: ['slow zoom in, subtle parallax', 'hair and clothes moving in the wind'],
  },
]

export const INTENT_MAP: Record<CreateIntent, IntentMeta> =
  Object.fromEntries(INTENTS.map((i) => [i.id, i])) as Record<CreateIntent, IntentMeta>
