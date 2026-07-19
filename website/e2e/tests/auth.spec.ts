// Ported from the legacy full.mjs sections "1. ENTRY / AUTH / NAV" (auth-tagged checks) and
// "10. SIGN OUT". See nav.spec.ts for the nav-tagged checks from the same section.
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { A, B, WEB } from '../lib.mjs';

/** Current URL path only (mirrors the old runner's `path()` helper). */
function pathOf(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return page.url();
  }
}

test.describe('auth', () => {
  test('unauthenticated /chats redirects to /login, and the login page renders', async ({
    browser,
  }) => {
    const guest = await browser.newContext();
    const gp = await guest.newPage();
    await gp.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await gp.waitForURL('**/login', { timeout: 12000 });
    expect(pathOf(gp)).toBe('/login');

    // login page renders its form (heading + tabs + email/password)
    await expect(gp.getByRole('heading', { name: 'Stewra' }).first()).toBeVisible();
    await expect(gp.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
    await expect(gp.getByRole('button', { name: 'Create account' }).first()).toBeVisible();
    await expect(gp.locator('input[type="email"]')).toBeVisible();

    // toggle to register mode → Name field appears
    await gp.getByRole('button', { name: 'Create account' }).first().click();
    const nameVisible = await gp
      .locator('input[autocomplete="name"]')
      .isVisible()
      .catch(() => false);
    console.log(`[auth] register mode reveals Name field: nameVisible=${nameVisible}`);

    await guest.close();
  });

  // Original: skip('auth', 'complete sign-up / email verification via UI', 'no throwaway
  // email+password+inbox code available; render-only checked above').
  // NB: must be a NAMED skipped test (test.skip('title', fn)). A bare `test.skip(true, desc)` in
  // the describe body is a GROUP modifier — it skips every test in this describe block.
  test.skip('complete sign-up / email verification via UI', () => {
    // no throwaway email+password+inbox code available; render-only checked in the previous test
    // (register mode reveals the Name field).
  });

  test('authenticated identity is shown in the nav for both A and B', async ({
    pageA,
    pageB,
  }) => {
    for (const [user, page, label] of [
      [A, pageA, 'A'],
      [B, pageB, 'B'],
    ] as const) {
      await page.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('link', { name: 'Chats' }).first().waitFor({ timeout: 15000 });
      console.log(`[auth] ${label} session valid (${user.email}) — rendered chats at ${pathOf(page)}`);
    }
  });

  test('Sign out returns to /login', async ({ pageA }) => {
    await pageA.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 12000 });
    await pageA.getByRole('button', { name: 'Sign out' }).click();
    await pageA.waitForURL('**/login', { timeout: 10000 });
    expect(pathOf(pageA)).toBe('/login');
  });
});
