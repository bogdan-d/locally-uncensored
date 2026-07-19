// 2.5.8 — typed wrappers for the local character trainer (musubi-tuner).
// The Rust side (src-tauri/src/commands/trainer.rs) owns the pinned repo,
// the dedicated venv and the whole train -> convert -> loras/ pipeline; this
// module is only the IPC surface the Create page talks to.

import { backendCall } from './backend'

export interface TrainerInstallState {
  status: string
  logs: string[]
}

export interface TrainerStatus {
  envReady: boolean
  basesReady: boolean
  dit: string | null
  textEncoder: string | null
  vae: string | null
  root: string
  install: TrainerInstallState
}

export interface TrainingRunStatus {
  status: 'idle' | 'running' | 'complete' | 'error' | 'cancelled' | string
  logs: string[]
  step: number
  totalSteps: number
}

/** The Z-Image training bases the trainer resolves by exact filename.
 *  Subfolders match the ComfyUI models tree so the regular download
 *  pipeline (download_model) drops them where both sides find them. */
export const TRAINER_BASE_FILES = [
  {
    filename: 'z_image_bf16.safetensors',
    subfolder: 'diffusion_models',
    url: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors',
    label: 'Z Image base model',
  },
  {
    filename: 'qwen_3_4b.safetensors',
    subfolder: 'text_encoders',
    url: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
    label: 'Text encoder',
  },
  {
    filename: 'ae.safetensors',
    subfolder: 'vae',
    url: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/vae/ae.safetensors',
    label: 'VAE',
  },
] as const

export async function installCharacterTrainer(installPath?: string): Promise<{ status: string }> {
  return backendCall('install_character_trainer', { installPath: installPath ?? null })
}

export async function characterTrainerStatus(): Promise<TrainerStatus> {
  return backendCall('character_trainer_status')
}

export async function stageTrainingImage(
  setId: string,
  filename: string,
  fileBytes: number[],
  caption: string,
): Promise<{ staged: string }> {
  return backendCall('stage_training_image', { setId, filename, fileBytes, caption })
}

export async function clearTrainingSet(setId: string): Promise<void> {
  await backendCall('clear_training_set', { setId })
}

export async function startCharacterTraining(
  setId: string,
  name: string,
  triggerWord: string,
  steps?: number,
): Promise<{ status: string }> {
  return backendCall('start_character_training', { setId, name, triggerWord, steps: steps ?? null })
}

export async function characterTrainingStatus(): Promise<TrainingRunStatus> {
  return backendCall('character_training_status')
}

export async function cancelCharacterTraining(): Promise<void> {
  await backendCall('cancel_character_training')
}

/** Local character LoRAs are recognized by the trainer's own naming
 *  (`char_<name>_zimage.safetensors`); the trigger word IS the name part —
 *  start_character_training writes it that way on purpose so the Use shelf
 *  can recover it without a sidecar database. */
export function parseLocalCharacterLora(file: string): { file: string; trigger: string } | null {
  // ComfyUI lists loras with their subfolder prefix — keep the full enum
  // string as `file` (LoraLoader needs it verbatim), match on the basename.
  const m = /(?:^|[\\/])char_(.+)_zimage\.safetensors$/i.exec(file.trim())
  if (!m) return null
  return { file: file.trim(), trigger: m[1] }
}
