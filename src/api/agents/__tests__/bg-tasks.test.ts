import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.fn()

vi.mock('../../backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
}))

import {
  bgStart,
  bgStatus,
  bgKill,
  bgList,
  renderBgStatusOneLine,
  type BgTaskStatus,
} from '../bg-tasks'

beforeEach(() => backendCall.mockReset())

describe('bgStart', () => {
  it('rejects empty commands without hitting the bridge', async () => {
    await expect(bgStart({ command: '' })).rejects.toThrow(/command is required/)
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('forwards command + optional cwd + shell to the bridge', async () => {
    backendCall.mockResolvedValueOnce({ id: 'abc' })
    await bgStart({ command: 'sleep 5', cwd: '/tmp', shell: 'bash' })
    expect(backendCall).toHaveBeenCalledOnce()
    expect(backendCall.mock.calls[0]).toEqual([
      'shell_task_start',
      { command: 'sleep 5', cwd: '/tmp', shell: 'bash' },
    ])
  })
})

describe('bgStatus / bgKill / bgList — JSON shape pass-through', () => {
  it('bgStatus returns the bridge payload verbatim', async () => {
    const payload: BgTaskStatus = {
      id: 'abc',
      command: 'sleep 1',
      cwd: null,
      started_at: 100,
      finished_at: 102,
      exit_code: 0,
      running: false,
      cancelled: false,
      output_tail: 'ok',
    }
    backendCall.mockResolvedValueOnce(payload)
    expect(await bgStatus('abc')).toEqual(payload)
    expect(backendCall.mock.calls[0]).toEqual(['shell_task_status', { id: 'abc' }])
  })

  it('bgKill returns the cancelled flag', async () => {
    backendCall.mockResolvedValueOnce({ ok: true, cancelled: true })
    const r = await bgKill('abc')
    expect(r).toEqual({ ok: true, cancelled: true })
  })

  it('bgList returns the tasks array', async () => {
    backendCall.mockResolvedValueOnce({ tasks: [] })
    expect(await bgList()).toEqual({ tasks: [] })
  })
})

describe('renderBgStatusOneLine', () => {
  function makeStatus(overrides: Partial<BgTaskStatus> = {}): BgTaskStatus {
    return {
      id: 'abcdef1234567890',
      command: 'sleep 5',
      cwd: null,
      started_at: 1700000000,
      finished_at: null,
      exit_code: null,
      running: true,
      cancelled: false,
      output_tail: '',
      ...overrides,
    }
  }

  it('reports running with elapsed seconds for live tasks', () => {
    const out = renderBgStatusOneLine(makeStatus())
    expect(out).toMatch(/^\[abcdef12\]/)
    expect(out).toMatch(/running/)
    expect(out).toMatch(/sleep 5/)
  })

  it('reports ok for exit_code 0', () => {
    const out = renderBgStatusOneLine(
      makeStatus({ running: false, finished_at: 1700000005, exit_code: 0 }),
    )
    expect(out).toMatch(/ok/)
    expect(out).toMatch(/\(5s\)/)
  })

  it('reports exit N for non-zero exits', () => {
    const out = renderBgStatusOneLine(
      makeStatus({ running: false, finished_at: 1700000010, exit_code: 2 }),
    )
    expect(out).toMatch(/exit 2/)
  })

  it('reports cancelled when the flag is set, regardless of exit_code', () => {
    const out = renderBgStatusOneLine(
      makeStatus({
        running: false,
        finished_at: 1700000010,
        exit_code: null,
        cancelled: true,
      }),
    )
    expect(out).toMatch(/cancelled/)
  })
})
