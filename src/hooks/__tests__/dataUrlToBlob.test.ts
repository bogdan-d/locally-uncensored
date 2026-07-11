import { describe, it, expect } from 'vitest'
import { dataUrlToBlob } from '../useCloudCreate'

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47]

function toDataUrl(bytes: number[], mime: string): string {
  return `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`
}

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL preserving bytes and mime', async () => {
    const bytes = [...PNG_HEADER, 0x00, 0xff, 0x7f]
    const blob = dataUrlToBlob(toDataUrl(bytes, 'image/png'))
    expect(blob.type).toBe('image/png')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(bytes)
  })

  it('decodes a percent-encoded (non-base64) data URL', async () => {
    const blob = dataUrlToBlob('data:text/plain,hello%20world')
    expect(blob.type).toBe('text/plain')
    expect(await blob.text()).toBe('hello world')
  })

  it('handles a mime with charset parameter before base64 marker', async () => {
    const blob = dataUrlToBlob(`data:image/jpeg;base64,${btoa('\xff\xd8\xff')}`)
    expect(blob.type).toBe('image/jpeg')
    expect((await blob.arrayBuffer()).byteLength).toBe(3)
  })

  it('defaults the mime when the data URL omits it', () => {
    const blob = dataUrlToBlob(`data:;base64,${btoa('x')}`)
    expect(blob.type).toBe('application/octet-stream')
  })

  it('throws on a blob: URL instead of silently making a text blob (mask 415 bug)', () => {
    // A blob: url slipped through as a mask ref once and got parsed into a text
    // blob of the url string, which the server 415'd. Guard fails loudly now.
    expect(() => dataUrlToBlob('blob:http://localhost/abc-123')).toThrow(/data: URL/)
  })
})
