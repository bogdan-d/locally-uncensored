import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, type CloudScenario } from './support/cloud-mock'

/**
 * 2.5.7 cloud gate — the wall in front of Cloud mode.
 *
 * (a) signed in without a plan → plan CTA opens lu-labs.ai/pricing in the
 *     SYSTEM browser (asserted via the mocked shell-open recorder), the mode
 *     stays Local;
 * (b) licensed but behind the Max-only launch gate (access:false) → the
 *     closed-beta wall, mode stays Local.
 */

async function boot(page: Page, scenario: CloudScenario) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, scenario)
  await page.goto('/')
  await expect(page.getByRole('radio', { name: /Local/i })).toBeVisible({ timeout: 20_000 })
}

test('signed in without a plan: plan CTA → browser, mode stays Local', async ({ page }) => {
  await boot(page, { license: 'none' })
  await signInViaGate(page)

  await expect(page.getByText(/no active plan/i)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /View plans/i }).click()

  const opened = await page.evaluate(() => (window as unknown as { __E2E_OPENED_URLS__?: string[] }).__E2E_OPENED_URLS__ ?? [])
  expect(opened.some((u) => u.includes('lu-labs.ai/pricing'))).toBe(true)

  // Gate holds: the switch is still on Local.
  await expect(page.getByRole('radio', { name: /Local/i })).toBeChecked()
})

test('licensed but beta-gated (access:false): closed-beta wall, mode stays Local', async ({ page }) => {
  await boot(page, { license: 'active', tier: 'hosted-pro', access: false })
  await signInViaGate(page)

  await expect(page.getByText(/closed beta/i)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('radio', { name: /Local/i })).toBeChecked()
})
