import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * 2.5.7 cloud onboarding — purple header switch → gate login → cloud mode.
 *
 * A Max-plan account flips the switch to Cloud through the gate modal: login
 * (email+password against the mocked Supabase), /api/me grants access, the
 * modal closes itself, and the chat picker surfaces ONLY the hosted catalog
 * while the local-hardware tabs disappear. Flipping back to Local restores
 * today's app. The very FIRST successful flip runs the one-time cloud
 * onboarding (own spec below).
 */

async function boot(page: Page, opts?: { cloudOnboardingSeen?: boolean }) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page, opts)
  await routeCloud(page, { license: 'active', tier: 'hosted-max', access: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
}

test('Max account: switch → login → cloud mode with the hosted catalog', async ({ page }) => {
  await boot(page)

  // Local-hardware tabs exist in local mode.
  await expect(page.getByRole('button', { name: /^Models$/ })).toBeVisible()

  await signInViaGate(page)

  // The gate flips the mode itself once the account clears every check.
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })

  // Local-hardware surfaces are gone in cloud mode.
  await expect(page.getByRole('button', { name: /^Models$/ })).toBeHidden()
  await expect(page.getByRole('button', { name: /^Benchmark$/ })).toBeHidden()

  // The chat picker lists the hosted catalog (and only it).
  await page.getByRole('button', { name: /New Chat/i }).click()
  const picker = page.getByText(/Llama 3\.1 8B Turbo/i).first()
  await expect(picker).toBeVisible({ timeout: 20_000 })

  // Flipping back to Local always works and restores the local tabs.
  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).not.toBeChecked()
  await expect(page.getByRole('button', { name: /^Models$/ })).toBeVisible()
})

test('first flip runs the one-time cloud onboarding before switching', async ({ page }) => {
  await boot(page, { cloudOnboardingSeen: false })

  await signInViaGate(page)

  // Instead of flipping silently, the one-time onboarding appears.
  await expect(page.getByText(/Welcome to LU Cloud/i)).toBeVisible({ timeout: 20_000 })
  await expect(cloudSwitch(page)).not.toBeChecked()

  await page.getByRole('button', { name: /Start Cloud mode/i }).click()
  await expect(cloudSwitch(page)).toBeChecked()

  // Seen persists: flipping off and on again is silent now.
  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).not.toBeChecked()
  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).toBeChecked()
  await expect(page.getByText(/Welcome to LU Cloud/i)).toBeHidden()
})
