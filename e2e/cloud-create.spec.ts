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

test('media_live=false: generate shows the honest coming-soon message', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: false })

  const composer = page.locator('textarea').first()
  await composer.fill('a lighthouse at dusk, cinematic')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect(page.getByText(/coming soon/i)).toBeVisible({ timeout: 15_000 })
})
