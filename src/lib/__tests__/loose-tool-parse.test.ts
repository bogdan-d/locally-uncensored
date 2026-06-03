import { describe, it, expect } from 'vitest'
import { parseLooseToolCalls, stripMatchedCalls, canonicalToolName } from '../loose-tool-parse'

const KNOWN = ['image_generate', 'video_generate', 'web_search', 'file_write']

describe('parseLooseToolCalls — function-call syntax', () => {
  it('extracts the exact prose call qwen2.5-coder wrote live', () => {
    const r = parseLooseToolCalls('image_generate(prompt="a small red cube on a wooden table")', KNOWN)
    expect(r.calls).toEqual([{ name: 'image_generate', arguments: { prompt: 'a small red cube on a wooden table' } }])
    expect(r.matched.length).toBe(1)
  })

  it('parses multiple kwargs incl. numbers + single quotes', () => {
    const r = parseLooseToolCalls("image_generate(prompt='a red cube', denoise=0.6, steps=20)", KNOWN)
    expect(r.calls[0]).toEqual({ name: 'image_generate', arguments: { prompt: 'a red cube', denoise: 0.6, steps: 20 } })
  })

  it('parses colon-style args', () => {
    const r = parseLooseToolCalls('image_generate(prompt: "sunset over hills")', KNOWN)
    expect(r.calls[0].arguments).toEqual({ prompt: 'sunset over hills' })
  })

  it('maps a single positional string to prompt', () => {
    const r = parseLooseToolCalls('image_generate("a lighthouse at dusk")', KNOWN)
    expect(r.calls[0].arguments).toEqual({ prompt: 'a lighthouse at dusk' })
  })

  it('parses video_generate with inputImage for image→video chaining', () => {
    const r = parseLooseToolCalls('video_generate(inputImage="locally_uncensored_00084_.png", prompt="gentle zoom")', KNOWN)
    expect(r.calls[0]).toEqual({
      name: 'video_generate',
      arguments: { inputImage: 'locally_uncensored_00084_.png', prompt: 'gentle zoom' },
    })
  })

  it('finds the call even inside a fenced code block', () => {
    const r = parseLooseToolCalls('Sure!\n```\nimage_generate(prompt="a fox")\n```', KNOWN)
    expect(r.calls[0].arguments).toEqual({ prompt: 'a fox' })
  })
})

describe('parseLooseToolCalls — JSON object syntax', () => {
  it('extracts {"name","arguments"}', () => {
    const r = parseLooseToolCalls('{"name": "image_generate", "arguments": {"prompt": "x"}}', KNOWN)
    expect(r.calls).toEqual([{ name: 'image_generate', arguments: { prompt: 'x' } }])
  })

  it('extracts a fenced ```json blob with {"tool","parameters"}', () => {
    const txt = 'Here:\n```json\n{"tool": "image_generate", "parameters": {"prompt": "a cat"}}\n```'
    const r = parseLooseToolCalls(txt, KNOWN)
    expect(r.calls[0]).toEqual({ name: 'image_generate', arguments: { prompt: 'a cat' } })
  })

  it('tolerates trailing commas (repairJson)', () => {
    const r = parseLooseToolCalls('{"name":"image_generate","arguments":{"prompt":"x",}}', KNOWN)
    expect(r.calls[0].name).toBe('image_generate')
  })
})

describe('parseLooseToolCalls — Hermes tags in content', () => {
  it('extracts a <tool_call> tag the model put in its answer', () => {
    const r = parseLooseToolCalls('<tool_call>\n{"name": "image_generate", "arguments": {"prompt": "y"}}\n</tool_call>', KNOWN)
    expect(r.calls[0]).toEqual({ name: 'image_generate', arguments: { prompt: 'y' } })
    expect(r.matched.some((s) => s.includes('<tool_call>'))).toBe(true)
  })
})

describe('parseLooseToolCalls — safety (no false positives)', () => {
  it('ignores unknown tool names', () => {
    expect(parseLooseToolCalls('do_something(x=1)', KNOWN).calls).toEqual([])
  })

  it('ignores a tool NAME mentioned in prose with no call', () => {
    expect(parseLooseToolCalls('You can use the image_generate tool to make pictures.', KNOWN).calls).toEqual([])
  })

  it('ignores empty parens (image_generate())', () => {
    expect(parseLooseToolCalls('Call image_generate() to start.', KNOWN).calls).toEqual([])
  })

  it('returns nothing for ordinary prose', () => {
    expect(parseLooseToolCalls('The cube is small and red, sitting on oak.', KNOWN).calls).toEqual([])
  })

  it('dedupes the same call found by two patterns', () => {
    const txt = 'image_generate(prompt="z") and also {"name":"image_generate","arguments":{"prompt":"z"}}'
    const r = parseLooseToolCalls(txt, KNOWN)
    expect(r.calls.length).toBe(1)
  })
})

describe('canonicalToolName — map near-miss tool names', () => {
  const KN = ['image_generate', 'video_generate', 'web_search', 'web_fetch', 'file_read']

  it('maps the exact miss gemma4 emitted live (video_generation → video_generate)', () => {
    expect(canonicalToolName('video_generation', KN)).toBe('video_generate')
  })

  it('maps common generate_* / *_generation aliases', () => {
    expect(canonicalToolName('image_generation', KN)).toBe('image_generate')
    expect(canonicalToolName('generate_video', KN)).toBe('video_generate')
    expect(canonicalToolName('generate_image', KN)).toBe('image_generate')
  })

  it('is punctuation/casing-insensitive (video-generate, VideoGenerate)', () => {
    expect(canonicalToolName('video-generate', KN)).toBe('video_generate')
    expect(canonicalToolName('VideoGenerate', KN)).toBe('video_generate')
  })

  it('passes exact names through unchanged', () => {
    expect(canonicalToolName('image_generate', KN)).toBe('image_generate')
  })

  it('leaves a genuinely unknown tool unchanged (still errors downstream)', () => {
    expect(canonicalToolName('teleport', KN)).toBe('teleport')
  })

  it('never maps an alias to a tool that is not registered', () => {
    expect(canonicalToolName('video_generation', ['image_generate'])).toBe('video_generation')
  })
})

describe('stripMatchedCalls', () => {
  it('removes the recognized call snippet from the prose', () => {
    const txt = 'Okay, generating now: image_generate(prompt="a red cube")'
    const r = parseLooseToolCalls(txt, KNOWN)
    const stripped = stripMatchedCalls(txt, r.matched)
    expect(stripped).not.toContain('image_generate(prompt=')
    expect(stripped.toLowerCase()).toContain('okay')
  })
})
