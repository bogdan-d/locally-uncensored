/**
 * Built-in Engine client (2.5.7) — P2.
 *
 * Pins the Tauri-command wrappers, the GGUF→AIModel mapper, and the
 * activate→swap path against the P1 command surface in
 * `src-tauri/src/commands/engine.rs`.
 *
 * Run: npx vitest run src/api/__tests__/engine.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn() }
})

import {
  startBundledEngine,
  stopBundledEngine,
  bundledEngineStatus,
  swapBundledModel,
  listBundledModels,
  bundledToAIModels,
  activateBuiltinModel,
  type BundledModel,
} from '../engine'
import { backendCall } from '../backend'

beforeEach(() => {
  vi.mocked(backendCall).mockReset()
})

describe('engine command wrappers', () => {
  it('starts the engine with camelCase args (Tauri maps → snake_case)', async () => {
    vi.mocked(backendCall).mockResolvedValue({ port: 8127 } as never)
    await startBundledEngine('/models/qwen.gguf', 4096)
    expect(backendCall).toHaveBeenCalledWith('start_bundled_engine', {
      modelPath: '/models/qwen.gguf',
      ctx: 4096,
    })
  })

  it('swaps the loaded model by path', async () => {
    vi.mocked(backendCall).mockResolvedValue({ port: 8127 } as never)
    await swapBundledModel('/models/other.gguf')
    expect(backendCall).toHaveBeenCalledWith('swap_bundled_model', {
      modelPath: '/models/other.gguf',
      ctx: undefined,
    })
  })

  it('stops the engine and reads status', async () => {
    vi.mocked(backendCall).mockResolvedValue({} as never)
    await stopBundledEngine()
    expect(backendCall).toHaveBeenCalledWith('stop_bundled_engine')

    vi.mocked(backendCall).mockResolvedValue({
      running: true, healthy: true, port: 8127, model_path: '/models/qwen.gguf',
    } as never)
    const status = await bundledEngineStatus()
    expect(status.port).toBe(8127)
    expect(backendCall).toHaveBeenCalledWith('bundled_engine_status')
  })

  it('unwraps the models array from list_bundled_models', async () => {
    vi.mocked(backendCall).mockResolvedValue({
      dir: '/data/models',
      models: [{ name: 'qwen', path: '/data/models/qwen.gguf', size: 400, loaded: true }],
    } as never)
    const models = await listBundledModels()
    expect(backendCall).toHaveBeenCalledWith('list_bundled_models')
    expect(models).toHaveLength(1)
    expect(models[0].name).toBe('qwen')
  })

  it('tolerates a missing models field', async () => {
    vi.mocked(backendCall).mockResolvedValue({ dir: '/data/models' } as never)
    expect(await listBundledModels()).toEqual([])
  })
})

describe('bundledToAIModels', () => {
  it('maps GGUFs to openai::-prefixed text models', () => {
    const bundled: BundledModel[] = [
      { name: 'qwen2.5-0.5b', path: '/m/qwen.gguf', size: 400, loaded: true },
      { name: 'llama3', path: '/m/llama3.gguf', size: 8000, loaded: false },
    ]
    const models = bundledToAIModels(bundled)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      name: 'openai::qwen2.5-0.5b',
      model: 'qwen2.5-0.5b',
      type: 'text',
      provider: 'openai',
      providerName: 'Built-in Engine',
    })
    expect(models[1].name).toBe('openai::llama3')
  })
})

describe('activateBuiltinModel', () => {
  it('resolves the path from the last list and calls swap', async () => {
    vi.mocked(backendCall).mockResolvedValue({
      dir: '/m',
      models: [{ name: 'qwen', path: '/m/qwen.gguf', size: 400, loaded: false }],
    } as never)
    await listBundledModels() // populates name→path map

    vi.mocked(backendCall).mockClear()
    const ok = await activateBuiltinModel('openai::qwen')
    expect(ok).toBe(true)
    expect(backendCall).toHaveBeenCalledWith('swap_bundled_model', {
      modelPath: '/m/qwen.gguf',
      ctx: undefined,
    })
  })

  it('accepts a bare (unprefixed) model id', async () => {
    vi.mocked(backendCall).mockResolvedValue({
      dir: '/m',
      models: [{ name: 'qwen', path: '/m/qwen.gguf', size: 400, loaded: false }],
    } as never)
    await listBundledModels()
    vi.mocked(backendCall).mockClear()
    expect(await activateBuiltinModel('qwen')).toBe(true)
  })

  it('no-ops when the path is unknown', async () => {
    vi.mocked(backendCall).mockResolvedValue({ dir: '/m', models: [] } as never)
    await listBundledModels()
    vi.mocked(backendCall).mockClear()
    const ok = await activateBuiltinModel('openai::ghost')
    expect(ok).toBe(false)
    expect(backendCall).not.toHaveBeenCalled()
  })
})
