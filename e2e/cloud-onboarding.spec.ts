import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate } from './support/cloud-mock'

/**
 * 2.5.7 cloud onboarding — header switch → gate login → cloud mode.
 *
 * A Max-plan account flips the global switch to Cloud through the gate modal:
 * login (email+password against the mocked Supabase), /api/me grants access,
 * the modal closes itself, and the chat picker surfaces ONLY the hosted
 * catalog (the mocked /api/inference/v1/models list) while the local-hardware
 * tabs disappear. Flipping back to Local restores today's app.
 */

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', tier: 'hosted-max', access: true })
  await page.goto('/')
  await expect(page.getByRole('radio', { name: /Local/i })).toBeVisible({ timeout: 20_000 })
}

test('Max account: switch → login → cloud mode with the hosted catalog', async ({ page }) => {
  await boot(page)

  // Local-hardware tabs exist in local mode.
  await expect(page.getByRole('button', { name: /^Models$/ })).toBeVisible()

  await signInViaGate(page)

  // The gate flips the mode itself once the account clears every check.
  await expect(page.getByRole('radio', { name: /Cloud/i })).toBeChecked({ timeout: 20_000 })

  // Local-hardware surfaces are gone in cloud mode.
  await expect(page.getByRole('button', { name: /^Models$/ })).toBeHidden()
  await expect(page.getByRole('button', { name: /^Benchmark$/ })).toBeHidden()

  // The chat picker lists the hosted catalog (and only it).
  await page.getByRole('button', { name: /New Chat/i }).click()
  const picker = page.getByText(/Llama 3\.1 8B Turbo/i).first()
  await expect(picker).toBeVisible({ timeout: 20_000 })

  // Flipping back to Local always works and restores the local tabs.
  await page.getByRole('radio', { name: /Local/i }).click()
  await expect(page.getByRole('button', { name: /^Models$/ })).toBeVisible()
})
