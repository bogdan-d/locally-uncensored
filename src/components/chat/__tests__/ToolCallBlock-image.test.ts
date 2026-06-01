/**
 * ToolCallBlock inline-image regex tests (F1 — konata3602 commitment 2026-05-23)
 *
 * INLINE_IMAGE_RE pulls a ComfyUI "/view" URL out of a tool result so the
 * chat UI can render the generated picture inline (ToolCallBlock.tsx:105
 * does `toolCall.result.match(INLINE_IMAGE_RE)` and feeds m[1] into <img src>).
 *
 * Two things must hold and are guarded here:
 *   1. The regex matches our own localhost/127.0.0.1 ComfyUI view URLs and
 *      does NOT match arbitrary third-party https URLs — auto-loading a
 *      remote image from tool output would be a CSP + privacy hole (see the
 *      comment above the regex in ToolCallBlock.tsx).
 *   2. The string executeImageGenerate() returns (builtin-tools.ts:937,
 *      `Image generated: <file> (prompt: "...")\n<url>`) places the URL where
 *      the regex can extract it cleanly.
 *
 * Run: npx vitest run src/components/chat/__tests__/ToolCallBlock-image.test.ts
 */
import { describe, it, expect } from 'vitest'
import { INLINE_IMAGE_RE, isInlineVideoUrl } from '../ToolCallBlock'

describe('INLINE_IMAGE_RE', () => {
  describe('positive cases (our own ComfyUI output)', () => {
    it('matches a localhost /view URL', () => {
      const url = 'http://localhost:8188/view?filename=foo.png&subfolder=&type=output&t=123'
      expect(INLINE_IMAGE_RE.test(url)).toBe(true)
      // The component renders m[1], so the capture group must be the whole URL.
      expect(url.match(INLINE_IMAGE_RE)?.[1]).toBe(url)
    })

    it('matches a 127.0.0.1 /view URL', () => {
      const url = 'http://127.0.0.1:8188/view?filename=x.png&subfolder=&type=output&t=456'
      expect(INLINE_IMAGE_RE.test(url)).toBe(true)
      expect(url.match(INLINE_IMAGE_RE)?.[1]).toBe(url)
    })
  })

  describe('negative cases (must NOT auto-load)', () => {
    it('does NOT match a third-party https URL', () => {
      // The whole point of bounding to localhost: a remote image URL in a
      // tool result must never be auto-fetched.
      expect(INLINE_IMAGE_RE.test('https://example.com/image.png')).toBe(false)
    })

    it('does NOT match a non-localhost host even on http /view', () => {
      expect(INLINE_IMAGE_RE.test('http://evil.example.com:8188/view?filename=a.png')).toBe(false)
    })

    it('does NOT match a localhost URL that is not the /view endpoint', () => {
      expect(INLINE_IMAGE_RE.test('http://localhost:8188/api/history/abc')).toBe(false)
    })
  })

  describe('integration with executeImageGenerate() output format', () => {
    // Mirrors the exact return string of executeImageGenerate (builtin-tools.ts:937):
    //   `Image generated: ${filename} (prompt: "${prompt}")\n${url}`
    // We hardcode a representative value rather than calling the function,
    // which submits a real ComfyUI workflow over the network. If that format
    // string changes, update this literal too.
    const result =
      'Image generated: foo.png (prompt: "test")\n' +
      'http://localhost:8188/view?filename=foo.png&subfolder=&type=output&t=123'

    it('extracts the URL from the full result string', () => {
      const m = result.match(INLINE_IMAGE_RE)
      expect(m).not.toBeNull()
      // The "Image generated: …" prose and the prompt text must be stripped —
      // only the bare URL ends up in <img src>.
      expect(m?.[1]).toBe('http://localhost:8188/view?filename=foo.png&subfolder=&type=output&t=123')
    })
  })
})

// Feature EE (v2.5.0): video_generate outputs render in <video>, images in
// <img>. isInlineVideoUrl inspects the `filename=` query param of the /view URL
// (NOT the URL tail, which ends in `&t=…`).
describe('isInlineVideoUrl', () => {
  it('detects .mp4 outputs from the filename query param', () => {
    expect(isInlineVideoUrl('http://localhost:8188/view?filename=clip.mp4&subfolder=&type=output&t=9')).toBe(true)
  })
  it('detects .webm outputs', () => {
    expect(isInlineVideoUrl('http://localhost:8188/view?filename=clip.webm&subfolder=&type=output&t=9')).toBe(true)
  })
  it('treats .png as NOT video (renders as <img>)', () => {
    expect(isInlineVideoUrl('http://localhost:8188/view?filename=foo.png&subfolder=&type=output&t=9')).toBe(false)
  })
  it('treats animated .webp as NOT video (animates fine in <img>)', () => {
    // SaveAnimatedWEBP output — must stay on the <img> path per spec.
    expect(isInlineVideoUrl('http://localhost:8188/view?filename=locally_uncensored_vid.webp&subfolder=&type=output&t=9')).toBe(false)
  })
  it('does not misfire on a .mp4 substring elsewhere in the query', () => {
    // The video check keys off the filename param, not a stray ".mp4" token.
    expect(isInlineVideoUrl('http://localhost:8188/view?filename=foo.png&subfolder=a.mp4dir&type=output')).toBe(false)
  })
})
