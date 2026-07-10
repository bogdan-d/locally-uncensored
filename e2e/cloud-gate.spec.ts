import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch, type CloudScenario } from './support/cloud-mock'

/**
 * 2.5.7 cloud gate — the wall in front of Cloud mode (David's 4-options flow).
 *
 * (a) signed in without a plan → the three plan buttons open lu-labs.ai/pricing
 *     in the SYSTEM browser (asserted via the mocked shell-open recorder),
 *     the switch stays off;
 * (b) licensed but behind the Max-only launch gate (access:false) → the
 *     closed-beta wall, switch stays off;
 * (c) "Stay on Local" closes the gate with the switch off.
 */

async function boot(page: Page, scenario: CloudScenario) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, scenario)
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
}

test('signed in without a plan: plan buttons → browser, switch stays off', async ({ page }) => {
  await boot(page, { license: 'none' })
  await signInViaGate(page)

  await expect(page.getByText(/no active plan/i)).toBeVisible({ timeout: 20_000 })

  // David's 4 options: three plans + back to Local.
  await expect(page.getByRole('button', { name: 'Hosted lu-labs.ai' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pro lu-labs.ai' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Stay on Local/i })).toBeVisible()
  await page.getByRole('button', { name: 'Max lu-labs.ai' }).click()

  const opened = await page.evaluate(() => (window as unknown as { __E2E_OPENED_URLS__?: string[] }).__E2E_OPENED_URLS__ ?? [])
  expect(opened.some((u) => u.includes('lu-labs.ai/pricing'))).toBe(true)

  // Gate holds: the switch is still off.
  await expect(cloudSwitch(page)).not.toBeChecked()
})

test('licensed but beta-gated (access:false): closed-beta wall, switch stays off', async ({ page }) => {
  await boot(page, { license: 'active', tier: 'hosted-pro', access: false })
  await signInViaGate(page)

  await expect(page.getByText(/closed beta/i)).toBeVisible({ timeout: 20_000 })
  await expect(cloudSwitch(page)).not.toBeChecked()
})

test('"Stay on Local" closes the gate with the switch off', async ({ page }) => {
  await boot(page, { license: 'none' })
  await signInViaGate(page)

  await expect(page.getByText(/no active plan/i)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /Stay on Local/i }).click()

  await expect(page.getByText(/no active plan/i)).toBeHidden()
  await expect(cloudSwitch(page)).not.toBeChecked()
})
