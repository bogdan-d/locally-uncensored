/**
 * CSP connect-src must whitelist the cloud LLM provider API hosts (GH #71).
 *
 * matheusroberson hit "violates the following Content Security Policy" when
 * testing OpenRouter on the desktop build. Cloud OpenAI-compatible + Anthropic
 * providers are reached by a DIRECT webview fetch (useLocalProxy is LAN-only),
 * so their API hosts must be in the desktop CSP connect-src or the provider
 * "Test" button AND every chat request are blocked by the webview CSP. The 2.5.5
 * security pass tightened this CSP, so pin the cloud hosts here — a future
 * tightening must not silently re-break cloud providers again.
 *
 * Run: npx vitest run src/api/__tests__/csp-cloud-hosts.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const conf = JSON.parse(readFileSync(resolve(here, '../../../src-tauri/tauri.conf.json'), 'utf8'))
const csp: string = conf.app.security.csp
const connectSrc = (csp.split(';').find((d) => d.trim().startsWith('connect-src')) ?? '').trim()

describe('CSP connect-src cloud provider hosts (GH #71)', () => {
  it.each([
    'https://openrouter.ai',
    'https://api.openai.com',
    'https://api.groq.com',
    'https://api.together.xyz',
    'https://api.deepseek.com',
    'https://api.mistral.ai',
    'https://api.anthropic.com',
  ])('connect-src whitelists %s', (host) => {
    expect(connectSrc).toContain(host)
  })

  it('keeps the existing localhost + model-download hosts', () => {
    expect(connectSrc).toContain("'self'")
    expect(connectSrc).toContain('http://localhost:*')
    expect(connectSrc).toContain('https://civitai.com')
    expect(connectSrc).toContain('https://huggingface.co')
    expect(connectSrc).toContain('https://ollama.com')
  })
})
