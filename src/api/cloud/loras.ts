// Desktop client for the Character-Studio shelf (server: user_loras via
// /api/loras). Training happens through the normal render queue (op
// 'lora-train'); the worker persists each delivered training onto the shelf,
// and generation references shelf rows by id — URLs never travel client-side.

import { cloudFetch, jsonOrError } from './client'

export interface CloudLora {
  id: string
  name: string
  trigger_word: string
  /** Which generation endpoints accept it: 'flux' | 'z-image' | 'qwen-image' | 'ltx-2'. */
  base_family: string
  created_at: string
}

export async function listLoras(): Promise<CloudLora[]> {
  const res = await cloudFetch('/api/loras')
  const { loras } = await jsonOrError<{ loras: CloudLora[] }>(res)
  return loras
}

export async function deleteLora(id: string): Promise<void> {
  const res = await cloudFetch(`/api/loras/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await jsonOrError<{ ok: boolean }>(res)
}
