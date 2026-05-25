// LM Studio per-model load/unload, mirroring the Ollama API surface in
// api/ollama.ts. LM Studio's HTTP server has no load/unload endpoints, so
// the bridge wraps the `lms` CLI for state changes and reads the loaded
// list from `/api/v0/models` where each entry has a `state` field. The
// frontend talks only to the bridge — no direct CLI shell-out from the
// browser.

import { backendCall } from './backend'

export async function listLoadedLmStudioModels(): Promise<string[]> {
  try {
    const data = await backendCall<{ loaded: string[] }>('lmstudio_list_loaded')
    return data.loaded ?? []
  } catch {
    return []
  }
}

export async function loadLmStudioModel(model: string): Promise<void> {
  await backendCall('lmstudio_load_model', { model })
}

export async function unloadLmStudioModel(model: string): Promise<void> {
  await backendCall('lmstudio_unload_model', { model })
}
