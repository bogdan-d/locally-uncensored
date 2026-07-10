import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, type CloudScenario } from './support/cloud-mock'

/**
 * 2.5.7 cloud create — hosted rendering through the global Cloud mode.
 *
 * (a) happy path: prompt → POST /api/jobs → poll → succeeded → the result
 *     lands in the gallery strip; the credits meter is visible; the
 *     cloud-only utility intents (Upscale/Erase) are offered.
 * (b) media_live:false from the catalog → generate degrades to the honest
 *     "coming soon" error instead of submitting.
 */

async function bootIntoCloudCreate(page: Page, scenario: CloudScenario) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, scenario)
  await page.goto('/')
  await expect(page.getByRole('radio', { name: /Local/i })).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(page.getByRole('radio', { name: /Cloud/i })).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
}

test('cloud render: submit → poll → gallery, meter + utility intents present', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true })

  // Cloud-only utility intents are offered on the cloud backend.
  await expect(page.getByRole('radio', { name: /Upscale/i })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: /Erase Object/i })).toBeVisible()

  // Credits meter reflects the mocked quota (remaining = 2,550,000 − 12,345).
  await expect(page.getByText('2537655')).toBeVisible()

  const composer = page.locator('textarea').first()
  await composer.fill('a lighthouse at dusk, cinematic')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  // The mocked job succeeds on the first poll; the image lands in the gallery.
  // Cloud results keep their remote signed URL (no base64 persistence).
  await expect(page.locator('img[src*="/e2e/result.png"]').first()).toBeVisible({ timeout: 30_000 })
})

test('ops start EMPTY and adopt a gallery image only on explicit pick', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true })

  // Render once so the gallery holds an image the old auto-adopt would grab.
  const composer = page.locator('textarea').first()
  await composer.fill('a lighthouse at dusk, cinematic')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect(page.locator('img[src*="/e2e/result.png"]').first()).toBeVisible({ timeout: 30_000 })

  // Switching to Edit must NOT auto-adopt the gallery image (David 2026-07-10):
  // the stage shows the empty input slot with the explicit gallery pick strip.
  await page.getByRole('radio', { name: /Edit Image/i }).click()
  await expect(page.getByText(/Drop an image to edit/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/or pick from your gallery/i)).toBeVisible()

  // Explicit pick adopts the image as the op source (source preview appears).
  await page.getByRole('button', { name: /Use this gallery image as the source/i }).first().click()
  await expect(page.getByRole('button', { name: /Paint mask/i })).toBeVisible({ timeout: 15_000 })
})

test('local mode offers only the local lane (no cloud-only ops)', async ({ page }) => {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(page.getByRole('radio', { name: /Local/i })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()

  await expect(page.getByRole('radio', { name: /^Image$/i })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: /^Video$/i })).toBeVisible()
  // David 2026-07-10: edit/animate/upscale/eraser have no local models — they
  // exist only on the cloud backend. removebg keeps its local RMBG lane.
  await expect(page.getByRole('radio', { name: /Remove Background/i })).toBeVisible()
  await expect(page.getByRole('radio', { name: /Edit Image/i })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /Animate Image/i })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /Upscale/i })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /Erase Object/i })).toHaveCount(0)
})

test('media_live=false: generate shows the honest coming-soon message', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: false })

  const composer = page.locator('textarea').first()
  await composer.fill('a lighthouse at dusk, cinematic')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect(page.getByText(/coming soon/i)).toBeVisible({ timeout: 15_000 })
})
