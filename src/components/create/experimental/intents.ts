import {
  Image as ImageIcon, Wand2, Scissors, Video, Film, Maximize2, Eraser,
  UserRound, Mic, Music, FastForward, PersonStanding,
} from 'lucide-react'
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
  /** Capability id (node probe) this intent depends on, if any. */
  capability?: 'rmbg' | 'inpaint-nodes' | 'dwpose'
  /** Categories with a hosted endpoint (cloud clip/teaser exists). */
  cloudOnly?: true
  /** 2.5.8: cloudOnly categories that ALSO run on the local ComfyUI backend
   *  (mirrors createStore's LOCAL_LANE_OPS). The IntentBar unlocks these in
   *  local mode; the cloud glyph becomes a "Try cloud" affordance. */
  hasLocalLane?: true
  /** Local model files this intent needs (gates the Download & install card). */
  requiresModels?: 'image' | 'video' | 'audio' | 'lipsync' | 'motion'
  examples: string[]
}

export const INTENTS: IntentMeta[] = [
  {
    id: 'image', label: 'Image', short: 'Image', icon: ImageIcon,
    placeholder: 'Describe your image…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: false,
    requiresModels: 'image',
    examples: [
      'a lighthouse at dusk, dramatic storm clouds, cinematic',
      'a neon alley in the rain, reflections, moody',
      'a cozy reading nook by a window, warm morning light',
    ],
  },
  {
    // Local lane since 2.5.7: mask inpaint on the SDXL/SD1.5 checkpoint path
    // (VAEEncodeForInpaint / InpaintModelConditioning) — the 4th local tab.
    // Cloud keeps its hosted edit endpoint; both share the MaskEditor.
    id: 'edit', label: 'Edit Image', short: 'Edit', icon: Wand2,
    placeholder: 'Describe the edit. What should change in the painted area…',
    needsSource: true, needsPrompt: true, allowsMask: true, isVideo: false,
    capability: 'inpaint-nodes', requiresModels: 'image',
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
    requiresModels: 'video',
    examples: ['a wave breaking on rocks in slow motion, cinematic', 'timelapse of clouds over a mountain range'],
  },
  {
    // Local lane restored 2026-07-17 (David): the lu-labs port had marked
    // animate cloudOnly, which silently dropped the local I2V the old Create
    // tab always had. Local builds route through buildDynamicWorkflow's
    // family-specific I2V wiring (WAN/WAN2.2/Hunyuan/LTX/Cosmos/SVD/FramePack);
    // the model picker only offers i2v-capable models here.
    id: 'animate', label: 'Animate Image', short: 'Animate', icon: Film,
    placeholder: 'Describe how the image should move…',
    needsSource: true, needsPrompt: true, allowsMask: false, isVideo: true,
    requiresModels: 'video',
    examples: ['slow zoom in, subtle parallax', 'hair and clothes moving in the wind'],
  },

  // ── 2.5.8 specialized categories (2026-07-17 David). All have hosted
  // endpoints (cloudOnly = cloud clip/teaser exists) and ALL run locally
  // since 2.5.8 (hasLocalLane) — core ComfyUI node families (ACE audio,
  // Wan S2V, I2V last-frame chain, Wan Animate/VACE) plus the bundled
  // musubi trainer for characters. Their composer surfaces own the extra
  // inputs (training set, audio, driving video, extend pick), so
  // needsSource / needsPrompt describe only the shared composer scaffolding. ──
  {
    // Local lane trains a Z-Image LoRA on the user's GPU (Rust-managed
    // musubi-tuner venv); the panel gates itself on trainer env + base files,
    // so no requiresModels here.
    id: 'character', label: 'Character Studio', short: 'Character', icon: UserRound,
    placeholder: 'Describe the scene for your character…',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: false,
    cloudOnly: true, hasLocalLane: true,
    examples: [],
  },
  {
    // Inputs (portrait or base clip + speech audio) are composer chips, not
    // the Stage source slot — which input the model needs depends on the
    // picked endpoint (photo-avatar vs re-sync).
    id: 'lipsync', label: 'Talking Character', short: 'Lipsync', icon: Mic,
    placeholder: '',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: true,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'lipsync',
    examples: [],
  },
  {
    id: 'music', label: 'Music', short: 'Music', icon: Music,
    placeholder: 'Describe the track. Genre, mood, tempo, instruments…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: false,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'audio',
    examples: [
      'dreamy lofi hip hop, vinyl crackle, mellow keys',
      'epic orchestral trailer, driving percussion',
      'upbeat synthwave, retro 80s arps',
    ],
  },
  {
    // Local lane: the picked clip's LAST FRAME becomes the I2V start image,
    // so it gates on the regular video models like animate does.
    id: 'extend', label: 'Extend Video', short: 'Extend', icon: FastForward,
    placeholder: 'Describe how the clip should continue…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: true,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'video',
    examples: [],
  },
  {
    // Character image + driving video are composer chips (see lipsync note).
    // Local lane needs the DWPose extractor (controlnet_aux pack) on top of
    // the Animate/VACE model files.
    id: 'motion', label: 'Motion Control', short: 'Motion', icon: PersonStanding,
    placeholder: 'Optional: extra style/scene hints…',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: true,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'motion', capability: 'dwpose',
    examples: [],
  },
]

export const INTENT_MAP: Record<CreateIntent, IntentMeta> =
  Object.fromEntries(INTENTS.map((i) => [i.id, i])) as Record<CreateIntent, IntentMeta>
