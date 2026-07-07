import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'

/**
 * P5 acceptance test — Document-Chat / RAG embeddings without Ollama.
 *
 * The whole point of P5 is that the RAG path embeds against the bundled
 * `llama-server --embeddings` (OpenAI `/v1/embeddings` on 8128), not Ollama.
 * With the Tauri mock reporting every external backend unreachable, this test:
 *
 *   1. Onboards on the built-in engine and installs the embedding model on the
 *      built-in path (GGUF download → start_bundled_embed), proving the
 *      onboarding embeddings step is Ollama-free.
 *   2. Drives the REAL RAG code (indexDocument → retrieveContext) in-page and
 *      asserts the vectors came back from the bundled server on :8128 — and
 *      that Ollama's :11434 /embed endpoint was never touched.
 */

async function installMock(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
}

test('document chat embeds via the bundled server, never Ollama', async ({ page }) => {
  await installMock(page)
  await page.goto('/')

  // welcome → backends (built-in preselected) → comfyui skip
  await page.getByRole('button', { name: /Get Started/i }).click()
  await page.getByRole('button', { name: /Continue/i }).click()
  await page.getByRole('button', { name: /Skip for now/i }).click()

  // models — install the starter GGUF, auto-advances to embeddings
  await expect(page.getByRole('heading', { name: /Pick a starter model/i })).toBeVisible()
  await page.getByRole('button', { name: /Qwen 2\.5 0\.5B/i }).click()
  await page.getByRole('button', { name: /Install \d+ model/i }).click()

  // embeddings — install on the built-in path (84 MB GGUF, not the 274 MB
  // Ollama pull). Success text proves the embed server booted with no Ollama.
  const embedInstall = page.getByRole('button', { name: /Install nomic-embed-text \(84 MB\)/i })
  await expect(embedInstall).toBeVisible({ timeout: 30_000 })
  await embedInstall.click()
  await expect(page.getByText(/Installed\. Document Chat is ready\./i)).toBeVisible({ timeout: 30_000 })

  // finish onboarding
  await page.getByRole('button', { name: /Continue/i }).click()
  await page.getByRole('button', { name: /Get Started/i }).click()

  // ── Drive the real RAG pipeline in-page against the mocked bundled embed ──
  const result = await page.evaluate(async () => {
    const rag = await import('/src/api/rag.ts')
    const file = new File(
      ['The mitochondria is the powerhouse of the cell. It produces ATP through respiration. ' +
       'Ribosomes synthesize proteins from messenger RNA in the cytoplasm of the cell.'],
      'bio.txt',
      { type: 'text/plain' },
    )
    const { chunks } = await rag.indexDocument(file)
    const retrieved = await rag.retrieveContext('what makes ATP in the cell', chunks, undefined, 2)
    return {
      chunkCount: chunks.length,
      embeddingDims: chunks.map((c: any) => (Array.isArray(c.embedding) ? c.embedding.length : 0)),
      retrievedChunks: retrieved.context.chunks.length,
      proxyUrls: (window as any).__E2E_PROXY_URLS__ || [],
    }
  })

  // The document was chunked and every chunk carries a real embedding vector.
  expect(result.chunkCount).toBeGreaterThan(0)
  expect(result.embeddingDims.every((d: number) => d > 0)).toBe(true)
  expect(result.retrievedChunks).toBeGreaterThan(0)

  // Embeddings hit the bundled server on 8128 …
  const urls: string[] = result.proxyUrls
  expect(urls.some((u) => u.includes(':8128') && u.includes('/v1/embeddings'))).toBe(true)
  // … and NEVER Ollama's /api/embed on 11434.
  expect(urls.some((u) => u.includes('11434') && u.includes('/embed'))).toBe(false)
})
