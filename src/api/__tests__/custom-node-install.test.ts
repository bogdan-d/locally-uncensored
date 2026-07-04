// #72 (bob, GH discussion 72): the VHS_VideoCombine install silently failed
// forever. The backend resolved a failed `git pull` as {status:"update_failed"}
// instead of rejecting, installCustomNodes never read the status, and the
// Create flow kept producing .webp with no error. These tests lock in the
// frontend half of the contract: any non installed/updated status is a failure.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async () => {
  const actual = await vi.importActual<typeof import('../backend')>('../backend')
  return {
    ...actual,
    backendCall: vi.fn(),
    isTauri: () => true,
  }
})

import { backendCall } from '../backend'
import { installCustomNodes, assertNodeInstallOk } from '../discover'

const mockedCall = vi.mocked(backendCall)

beforeEach(() => {
  mockedCall.mockReset()
})

describe('assertNodeInstallOk (#72)', () => {
  it('throws on update_failed', () => {
    expect(() => assertNodeInstallOk({ status: 'update_failed', path: 'x' }, 'VHS'))
      .toThrow(/update_failed/)
  })

  it('accepts installed and updated', () => {
    expect(() => assertNodeInstallOk({ status: 'installed' }, 'VHS')).not.toThrow()
    expect(() => assertNodeInstallOk({ status: 'updated' }, 'VHS')).not.toThrow()
  })

  it('tolerates results without a status field', () => {
    expect(() => assertNodeInstallOk(undefined, 'VHS')).not.toThrow()
    expect(() => assertNodeInstallOk(null, 'VHS')).not.toThrow()
    expect(() => assertNodeInstallOk({ path: 'x' }, 'VHS')).not.toThrow()
  })
})

describe('installCustomNodes (#72)', () => {
  it('rejects when the backend reports update_failed instead of treating it as success', async () => {
    mockedCall.mockResolvedValue({ status: 'update_failed', path: 'C:/x' })

    await expect(installCustomNodes(['videohelpersuite']))
      .rejects.toThrow(/Failed to install ComfyUI-VideoHelperSuite/)
  })

  it('resolves when the backend reports installed', async () => {
    mockedCall.mockResolvedValue({ status: 'installed', path: 'C:/x' })

    await expect(installCustomNodes(['videohelpersuite'])).resolves.toBeUndefined()
    expect(mockedCall).toHaveBeenCalledWith('install_custom_node', {
      repoUrl: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite',
      nodeName: 'ComfyUI-VideoHelperSuite',
    })
  })

  it('still rejects on a real backend error', async () => {
    mockedCall.mockRejectedValue(new Error('Failed to clone: network down'))

    await expect(installCustomNodes(['videohelpersuite']))
      .rejects.toThrow(/network down/)
  })
})
