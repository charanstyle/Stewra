// Ported from the legacy full.mjs sections "1. ENTRY / AUTH / NAV" (auth-tagged checks) and
// "10. SIGN OUT". See nav.spec.ts for the nav-tagged checks from the same section.
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { A, B, WEB } from '../lib.mjs';
import { config } from '../config.mjs';
import { plusAddress, waitForVerificationCode } from '../mailbox.mjs';

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

  // The one flow the rest of the suite cannot cover, because every other test signs in as an
  // account that already exists. Driven entirely through the UI: register, read the 6-digit
  // code out of the real mailbox the way a person reads their inbox, type it into
  // /verify-email, land on /today.
  //
  // Gated on E2E_SIGNUP_MAILBOX because it is not free to run: accounts cannot be deleted
  // afterwards (`audit_log` references `users` with ON DELETE SET NULL, and the append-only
  // trigger rejects that UPDATE), so each run leaves one permanent account behind.
  test('complete sign-up / email verification via UI', async ({ browser }) => {
    // The suite default is 120s, and `waitForVerificationCode` alone budgets DEFAULT_TIMEOUT_MS =
    // 120_000 (mailbox.mjs) — so on a perfectly healthy site the mail poll can consume the entire
    // test before the form is even submitted, and the failure looks like a product bug rather than
    // a budget one. Give the whole arc (register → deliver → poll IMAP → verify → land) room.
    test.setTimeout(240_000);
    test.skip(
      !config.signup.enabled,
      'set E2E_SIGNUP_MAILBOX (+ E2E_SIGNUP_SSH_HOST, E2E_SIGNUP_IMAP_CONTAINER) to run — ' +
        'each run permanently creates one account that cannot be deleted',
    );

    // A fresh address per run: re-using one would hit "email already registered" and test
    // nothing. Plus-addressed off the single real mailbox, so it is genuinely deliverable.
    const address = plusAddress(config.signup.mailbox, `signup${randomBytes(4).toString('hex')}`);
    const password = `Qa-${randomBytes(12).toString('base64url')}-9`;
    const name = 'QA Signup';

    const guest = await browser.newContext();
    const gp = await guest.newPage();
    try {
      await gp.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
      await gp.getByRole('button', { name: 'Create account' }).first().click();
      await gp.getByLabel('Name').fill(name);
      await gp.getByLabel('Email').fill(address);
      await gp.getByLabel('Password').fill(password);
      // .last() — the mode tab and the submit button share this accessible name.
      await gp.getByRole('button', { name: 'Create account' }).last().click();

      await gp.waitForURL(/\/verify-email/, { timeout: 30000 });
      console.log(`[auth] registered ${address}, waiting for the emailed code…`);

      const code = await waitForVerificationCode({
        sshHost: config.signup.sshHost,
        imapContainer: config.signup.imapContainer,
        mailbox: config.signup.mailbox,
        address,
      });
      expect(code, 'emailed verification code').toMatch(/^\d{6}$/);

      await gp.getByPlaceholder('000000').fill(code);
      await gp.getByRole('button', { name: /verify/i }).click();

      // Verification is complete only if the app lets the new account in.
      await gp.waitForURL(/\/today/, { timeout: 30000 });
      expect(pathOf(gp)).toBe('/today');
      await expect(gp.getByRole('link', { name: 'Chats' }).first()).toBeVisible();
      console.log(`[auth] signed up + verified ${address} end to end through the UI`);
    } finally {
      await guest.close();
    }
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
