import { classifyModel, findMatchingVAE, findMatchingCLIP } from './comfyui'
import type { ModelType, GenerateParams, VideoParams } from './comfyui'
import {
  getAllNodeInfo,
  categorizeNodes,
  detectAvailableModels,
  type NodeMetadata,
  type CategorizedNodes,
  type AvailableModels,
} from './comfyui-nodes'

// ─── Strategy Detection ───

export type WorkflowStrategy =
  | 'unet_flux'       // FLUX/FLUX2: UNETLoader + CLIPLoader + VAELoader + EmptySD3LatentImage
  | 'unet_video'      // Wan/Hunyuan: UNETLoader + CLIPLoader + VAELoader + EmptyHunyuanLatentVideo
  | 'checkpoint'      // SDXL/SD1.5: CheckpointLoaderSimple + EmptyLatentImage
  | 'animatediff'     // AnimateDiff: CheckpointLoaderSimple + ADE_* nodes
  | 'unavailable'

interface StrategyResult {
  strategy: WorkflowStrategy
  reason: string
}

function determineStrategy(
  modelType: ModelType,
  isVideo: boolean,
  nodes: CategorizedNodes,
  models: AvailableModels,
): StrategyResult {
  const hasUNET = nodes.loaders.includes('UNETLoader')
  const hasCheckpoint = nodes.loaders.includes('CheckpointLoaderSimple')
  const hasCLIPLoader = nodes.loaders.includes('CLIPLoader')
  const hasVAELoader = nodes.loaders.includes('VAELoader')
  const hasAnimateDiff = nodes.motion.includes('ADE_LoadAnimateDiffModel')

  // FLUX / FLUX2 → always UNET-based
  if (modelType === 'flux' || modelType === 'flux2') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_flux', reason: `${modelType} model → UNETLoader pipeline` }
    }
    return { strategy: 'unavailable', reason: 'FLUX requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // Wan / Hunyuan → UNET-based with video latent
  if (modelType === 'wan' || modelType === 'hunyuan') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_video', reason: `${modelType} model → UNETLoader + video latent` }
    }
    return { strategy: 'unavailable', reason: 'Wan/Hunyuan requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // SDXL / SD1.5 / Unknown
  if (isVideo && hasAnimateDiff && hasCheckpoint && models.motionModels.length > 0) {
    return { strategy: 'animatediff', reason: 'Video mode → AnimateDiff pipeline' }
  }

  if (hasCheckpoint) {
    return { strategy: 'checkpoint', reason: 'Checkpoint-based pipeline' }
  }

  // Last resort: try UNET if available
  if (hasUNET && hasCLIPLoader && hasVAELoader) {
    return { strategy: 'unet_flux', reason: 'Fallback to UNETLoader (no checkpoint loader)' }
  }

  return { strategy: 'unavailable', reason: 'No compatible loader nodes found in ComfyUI' }
}

// ─── Dynamic Workflow Builder ───

export async function buildDynamicWorkflow(
  params: GenerateParams | VideoParams,
  modelType?: ModelType,
): Promise<Record<string, any>> {
  const type = modelType || classifyModel(params.model)
  const isVideo = 'frames' in params
  const videoParams = params as VideoParams

  // Fetch node info (cached)
  const allNodes = await getAllNodeInfo()
  const nodes = categorizeNodes(allNodes)
  const models = detectAvailableModels(allNodes)

  const { strategy, reason } = determineStrategy(type, isVideo, nodes, models)
  console.log(`[dynamic-workflow] Strategy: ${strategy} (${reason})`)

  if (strategy === 'unavailable') {
    throw new Error(reason)
  }

  const workflow: Record<string, any> = {}
  let n = 1 // node counter

  const seed = params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed

  // ─── Phase 1: Model Loading ───

  let modelNodeId: string
  let clipSourceId: string
  let clipOutputSlot: number
  let vaeSourceId: string
  let vaeOutputSlot: number
  let samplerModelId: string

  if (strategy === 'checkpoint') {
    // Single loader: outputs MODEL (0), CLIP (1), VAE (2)
    modelNodeId = String(n++)
    workflow[modelNodeId] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.model },
    }
    clipSourceId = modelNodeId
    clipOutputSlot = 1
    vaeSourceId = modelNodeId
    vaeOutputSlot = 2
    samplerModelId = modelNodeId

  } else if (strategy === 'unet_flux' || strategy === 'unet_video') {
    // Separate loaders
    const unetId = String(n++)
    const clipId = String(n++)
    const vaeId = String(n++)

    const clipType = type === 'flux2' ? 'flux2'
      : type === 'flux' ? 'flux'
      : (type === 'wan' || type === 'hunyuan') ? 'wan'
      : 'flux'

    let vae: string, clip: string
    try { vae = await findMatchingVAE(type) } catch { vae = models.vaes[0] || '' }
    try { clip = await findMatchingCLIP(type) } catch { clip = models.clips[0] || '' }

    workflow[unetId] = {
      class_type: 'UNETLoader',
      inputs: { unet_name: params.model, weight_dtype: 'default' },
    }
    workflow[clipId] = {
      class_type: 'CLIPLoader',
      inputs: { clip_name: clip, type: clipType, device: 'default' },
    }
    workflow[vaeId] = {
      class_type: 'VAELoader',
      inputs: { vae_name: vae },
    }

    modelNodeId = unetId
    clipSourceId = clipId
    clipOutputSlot = 0
    vaeSourceId = vaeId
    vaeOutputSlot = 0
    samplerModelId = unetId

  } else {
    // AnimateDiff: checkpoint + motion model
    const ckptId = String(n++)
    const motionLoadId = String(n++)
    const motionApplyId = String(n++)
    const evolvedId = String(n++)

    workflow[ckptId] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.model },
    }
    workflow[motionLoadId] = {
      class_type: 'ADE_LoadAnimateDiffModel',
      inputs: { model_name: models.motionModels[0] },
    }
    workflow[motionApplyId] = {
      class_type: 'ADE_ApplyAnimateDiffModelSimple',
      inputs: { motion_model: [motionLoadId, 0] },
    }
    workflow[evolvedId] = {
      class_type: 'ADE_UseEvolvedSampling',
      inputs: {
        model: [ckptId, 0],
        m_models: [motionApplyId, 0],
        beta_schedule: 'autoselect',
      },
    }

    modelNodeId = ckptId
    clipSourceId = ckptId
    clipOutputSlot = 1
    vaeSourceId = ckptId
    vaeOutputSlot = 2
    samplerModelId = evolvedId
  }

  // ─── Phase 2: Text Encoding ───

  const posId = String(n++)
  const negId = String(n++)

  workflow[posId] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: params.prompt, clip: [clipSourceId, clipOutputSlot] },
  }
  workflow[negId] = {
    class_type: 'CLIPTextEncode',
    inputs: {
      text: params.negativePrompt || '',
      clip: [clipSourceId, clipOutputSlot],
    },
  }

  // ─── Phase 3: Latent Initialization ───

  const latentId = String(n++)

  if (strategy === 'unet_video') {
    // Wan/Hunyuan video latent
    const latentNode = nodes.latentInit.includes('EmptyHunyuanLatentVideo')
      ? 'EmptyHunyuanLatentVideo'
      : 'EmptyLatentImage'

    workflow[latentId] = {
      class_type: latentNode,
      inputs: latentNode === 'EmptyHunyuanLatentVideo'
        ? { width: params.width, height: params.height, length: videoParams.frames, batch_size: 1 }
        : { width: params.width, height: params.height, batch_size: videoParams.frames },
    }
  } else if (strategy === 'animatediff') {
    // AnimateDiff: batch_size = frames
    workflow[latentId] = {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: videoParams.frames },
    }
  } else if (strategy === 'unet_flux') {
    // FLUX uses SD3 latent
    const latentNode = nodes.latentInit.includes('EmptySD3LatentImage')
      ? 'EmptySD3LatentImage'
      : 'EmptyLatentImage'

    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  } else {
    // Checkpoint (SDXL/SD1.5)
    workflow[latentId] = {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  }

  // ─── Phase 4: Sampling ───

  const samplerId = String(n++)

  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: [samplerModelId, 0],
      positive: [posId, 0],
      negative: [negId, 0],
      latent_image: [latentId, 0],
      seed,
      steps: params.steps,
      cfg: params.cfgScale,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: 1.0,
    },
  }

  // ─── Phase 5: Decode ───

  const decodeId = String(n++)

  workflow[decodeId] = {
    class_type: 'VAEDecode',
    inputs: {
      samples: [samplerId, 0],
      vae: [vaeSourceId, vaeOutputSlot],
    },
  }

  // ─── Phase 6: Output ───

  const saveId = String(n++)

  if (isVideo) {
    // Video output: prefer VHS > SaveAnimatedWEBP > SaveImage
    if (nodes.videoSavers.includes('VHS_VideoCombine')) {
      workflow[saveId] = {
        class_type: 'VHS_VideoCombine',
        inputs: {
          images: [decodeId, 0],
          frame_rate: videoParams.fps,
          loop_count: 0,
          filename_prefix: 'locally_uncensored_vid',
          format: 'video/h264-mp4',
          pingpong: false,
          save_output: true,
        },
      }
    } else if (nodes.videoSavers.includes('SaveAnimatedWEBP')) {
      workflow[saveId] = {
        class_type: 'SaveAnimatedWEBP',
        inputs: {
          images: [decodeId, 0],
          filename_prefix: 'locally_uncensored_vid',
          fps: videoParams.fps,
          lossless: false,
          quality: 90,
          method: 'default',
        },
      }
    } else {
      workflow[saveId] = {
        class_type: 'SaveImage',
        inputs: {
          images: [decodeId, 0],
          filename_prefix: 'locally_uncensored_vid',
        },
      }
    }
  } else {
    workflow[saveId] = {
      class_type: 'SaveImage',
      inputs: {
        images: [decodeId, 0],
        filename_prefix: 'locally_uncensored',
      },
    }
  }

  console.log(`[dynamic-workflow] Built ${Object.keys(workflow).length} nodes:`,
    Object.entries(workflow).map(([id, node]) => `${id}:${node.class_type}`).join(' → ')
  )

  return workflow
}
