export interface ComfyUIModel {
  name: string
  type: 'checkpoint' | 'lora' | 'vae'
}

export interface GenerateParams {
  prompt: string
  negativePrompt: string
  model: string
  sampler: string
  steps: number
  cfgScale: number
  width: number
  height: number
  seed: number
  batchSize?: number
}

export interface VideoParams extends GenerateParams {
  frames: number
  fps: number
}

export interface ComfyUIOutput {
  filename: string
  subfolder: string
  type: string
}

export type VideoBackend = 'wan' | 'animatediff' | 'none'

// ─── Connection & Info ───

export async function checkComfyConnection(): Promise<boolean> {
  try {
    const res = await fetch('/comfyui/system_stats')
    return res.ok
  } catch {
    return false
  }
}

export async function getCheckpoints(): Promise<string[]> {
  try {
    const res = await fetch('/comfyui/object_info/CheckpointLoaderSimple')
    const data = await res.json()
    return data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || []
  } catch {
    return []
  }
}

export async function getDiffusionModels(): Promise<string[]> {
  try {
    const res = await fetch('/comfyui/object_info/UNETLoader')
    const data = await res.json()
    return data?.UNETLoader?.input?.required?.unet_name?.[0] || []
  } catch {
    return []
  }
}

export async function getVAEModels(): Promise<string[]> {
  try {
    const res = await fetch('/comfyui/object_info/VAELoader')
    const data = await res.json()
    return data?.VAELoader?.input?.required?.vae_name?.[0] || []
  } catch {
    return []
  }
}

export async function getCLIPModels(): Promise<string[]> {
  try {
    const res = await fetch('/comfyui/object_info/CLIPLoader')
    const data = await res.json()
    return data?.CLIPLoader?.input?.required?.clip_name?.[0] || []
  } catch {
    return []
  }
}

export async function getSamplers(): Promise<string[]> {
  try {
    const res = await fetch('/comfyui/object_info/KSampler')
    const data = await res.json()
    return data?.KSampler?.input?.required?.sampler_name?.[0] || []
  } catch {
    return ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_sde', 'uni_pc', 'ddim']
  }
}

export async function getSchedulers(): Promise<string[]> {
  try {
    const res = await fetch('/comfyui/object_info/KSampler')
    const data = await res.json()
    return data?.KSampler?.input?.required?.scheduler?.[0] || []
  } catch {
    return ['normal', 'karras', 'simple', 'exponential', 'sgm_uniform']
  }
}

// ─── Detect available video backend ───

export async function detectVideoBackend(): Promise<VideoBackend> {
  try {
    const res = await fetch('/comfyui/object_info')
    const data = await res.json()
    // Check for Wan nodes (built-in, preferred)
    if (data['EmptyHunyuanLatentVideo'] && data['UNETLoader'] && data['CLIPLoader'] && data['VAELoader']) {
      return 'wan'
    }
    // Check for AnimateDiff nodes (custom, fallback)
    if (data['ADE_LoadAnimateDiffModel'] && data['ADE_UseEvolvedSampling']) {
      return 'animatediff'
    }
  } catch { /* ignore */ }
  return 'none'
}

// ─── Workflow Submission ───

export async function submitWorkflow(workflow: Record<string, any>): Promise<string> {
  const res = await fetch('/comfyui/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Failed to submit workflow: ${err}`)
  }
  const data = await res.json()
  return data.prompt_id
}

export async function getHistory(promptId: string): Promise<any> {
  const res = await fetch(`/comfyui/history/${promptId}`)
  if (!res.ok) return null
  const data = await res.json()
  return data[promptId] || null
}

export function getImageUrl(filename: string, subfolder: string = '', type: string = 'output'): string {
  return `/comfyui/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`
}

// ─── Image Workflow (Standard SDXL/SD) ───

export function buildTxt2ImgWorkflow(params: GenerateParams): Record<string, any> {
  const seed = params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.model },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.prompt, clip: ['1', 1] },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.negativePrompt || '', clip: ['1', 1] },
    },
    '4': {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize || 1 },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        seed,
        steps: params.steps,
        cfg: params.cfgScale,
        sampler_name: params.sampler,
        scheduler: 'normal',
        denoise: 1.0,
      },
    },
    '6': {
      class_type: 'VAEDecode',
      inputs: { samples: ['5', 0], vae: ['1', 2] },
    },
    '7': {
      class_type: 'SaveImage',
      inputs: { images: ['6', 0], filename_prefix: 'locally_uncensored' },
    },
  }
}

// ─── Video Workflow: Wan 2.1/2.2 (built-in nodes) ───

export function buildWanVideoWorkflow(params: VideoParams): Record<string, any> {
  const seed = params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed

  // Auto-detect model files from the selected model name
  // Users select a diffusion model; we try to find matching CLIP and VAE
  return {
    '1': {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: params.model.includes('clip') ? params.model : 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
        type: 'wan',
        device: 'default',
      },
    },
    '2': {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: params.model,
        weight_dtype: 'default',
      },
    },
    '3': {
      class_type: 'VAELoader',
      inputs: {
        vae_name: 'wan_2.1_vae.safetensors',
      },
    },
    '4': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.prompt, clip: ['1', 0] },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.negativePrompt || 'static, blurred, low quality, worst quality, deformed', clip: ['1', 0] },
    },
    '6': {
      class_type: 'EmptyHunyuanLatentVideo',
      inputs: {
        width: params.width,
        height: params.height,
        length: params.frames,
        batch_size: 1,
      },
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        seed,
        steps: params.steps,
        cfg: params.cfgScale,
        sampler_name: params.sampler || 'uni_pc',
        scheduler: 'simple',
        denoise: 1.0,
      },
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['7', 0], vae: ['3', 0] },
    },
    '9': {
      class_type: 'SaveAnimatedWEBP',
      inputs: {
        images: ['8', 0],
        filename_prefix: 'locally_uncensored_vid',
        fps: params.fps,
        lossless: false,
        quality: 90,
        method: 'default',
      },
    },
  }
}

// ─── Video Workflow: AnimateDiff (requires custom nodes) ───

export function buildAnimateDiffWorkflow(params: VideoParams): Record<string, any> {
  const seed = params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed

  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.model },
    },
    '2': {
      class_type: 'ADE_LoadAnimateDiffModel',
      inputs: { model_name: 'mm_sd15_v3.safetensors' },
    },
    '3': {
      class_type: 'ADE_ApplyAnimateDiffModelSimple',
      inputs: { motion_model: ['2', 0] },
    },
    '4': {
      class_type: 'ADE_UseEvolvedSampling',
      inputs: {
        model: ['1', 0],
        m_models: ['3', 0],
        beta_schedule: 'autoselect',
      },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.prompt, clip: ['1', 1] },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.negativePrompt || 'low quality, blurry, static', clip: ['1', 1] },
    },
    '7': {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: params.frames },
    },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0],
        positive: ['5', 0],
        negative: ['6', 0],
        latent_image: ['7', 0],
        seed,
        steps: params.steps,
        cfg: params.cfgScale,
        sampler_name: params.sampler,
        scheduler: 'normal',
        denoise: 1.0,
      },
    },
    '9': {
      class_type: 'VAEDecode',
      inputs: { samples: ['8', 0], vae: ['1', 2] },
    },
    '10': {
      class_type: 'VHS_VideoCombine',
      inputs: {
        images: ['9', 0],
        frame_rate: params.fps,
        loop_count: 0,
        filename_prefix: 'locally_uncensored_vid',
        format: 'video/h264-mp4',
        pingpong: false,
        save_output: true,
      },
    },
  }
}

// ─── Auto-select the right video workflow ───

export function buildTxt2VidWorkflow(params: VideoParams, backend: VideoBackend): Record<string, any> {
  switch (backend) {
    case 'wan':
      return buildWanVideoWorkflow(params)
    case 'animatediff':
      return buildAnimateDiffWorkflow(params)
    default:
      throw new Error('No video generation backend available. Install Wan 2.1 models or AnimateDiff nodes in ComfyUI.')
  }
}
