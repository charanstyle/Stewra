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

    // toggle to register mode → Name field appears. Asserted with `expect(locator)`, which retries:
    // the previous `isVisible()` + console.log answered against the DOM as it stood the instant
    // after the click and could only ever report, never fail — the same shape that let the
    // invite-by-email 404 ship green (see the header of contacts.spec.ts).
    await gp.getByRole('button', { name: 'Create account' }).first().click();
    await expect(gp.locator('input[autocomplete="name"]')).toBeVisible();

    await guest.close();
  });

  // The one flow the rest of the suite cannot cover, because every other test signs in as an
  // account that already exists. Driven entirely through the UI: register, read the 6-digit
  // code out of the real mailbox the way a person reads their inbox, type it into
  // /verify-email, land on /today.
  //
  // Gated on E2E_SIGNUP_MAILBOX because it needs a mailbox a machine can read. Each run leaves
  // one account behind — no longer a *permanent* one: migration 062 fixed the append-only trigger
  // that rejected the `audit_log` SET NULL, so these can now be removed the way a user would, and
  // `accountDeletion.spec.ts` does exactly that with an account it creates itself.
  //
  // Every account is an organization (migration 063): an Individual signup lands with a personal
  // org it never asked for, a Business signup with one named after the company. Both shapes are
  // driven below, and each ends on /commerce where the org list says which kind was created — the
  // kind is what the rest of the product keys on (invites, the fleet page, "which org did you
  // mean"), so a signup that verifies but lands with the wrong org is a failed signup.
  async function signUpThroughTheUi(
    gp: Page,
    shape: { kind: 'individual' } | { kind: 'business'; companyName: string },
  ): Promise<string> {
    // A fresh address per run: re-using one would hit "email already registered" and test
    // nothing. Plus-addressed off the single real mailbox, so it is genuinely deliverable.
    const address = plusAddress(
      config.signup.mailbox,
      `signup${shape.kind}${randomBytes(4).toString('hex')}`,
    );
    const password = `Qa-${randomBytes(12).toString('base64url')}-9`;
    const name = 'QA Signup';

    await gp.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
    await gp.getByRole('button', { name: 'Create account' }).first().click();
    await gp.getByTestId(`register-kind-${shape.kind}`).click();
    await expect(gp.getByTestId(`register-kind-${shape.kind}`)).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await gp.getByLabel('Name').fill(name);
    await gp.getByLabel('Email').fill(address);
    await gp.getByLabel('Password').fill(password);
    if (shape.kind === 'business') {
      await gp.getByTestId('register-company-name').fill(shape.companyName);
    } else {
      // An individual is never asked for a company — the field must not be on the page at all.
      await expect(gp.getByTestId('register-company-name')).toHaveCount(0);
    }
    // .last() — the mode tab and the submit button share this accessible name.
    await gp.getByRole('button', { name: 'Create account' }).last().click();

    await gp.waitForURL(/\/verify-email/, { timeout: 30000 });
    console.log(`[auth] registered ${address} (${shape.kind}), waiting for the emailed code…`);

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
    return address;
  }

  /** The org list on /commerce renders each membership as "<name> · personal|business · <role>". */
  async function expectOrgListed(
    gp: Page,
    orgName: string,
    kind: 'personal' | 'business',
  ): Promise<void> {
    await gp.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const option = gp.locator('option', { hasText: `${orgName} · ${kind} · owner` });
    await expect(option, `org "${orgName}" listed as ${kind}, owned`).toHaveCount(1);
  }

  const SIGNUP_SKIP_REASON =
    'set E2E_SIGNUP_MAILBOX (+ E2E_SIGNUP_SSH_HOST, E2E_SIGNUP_IMAP_CONTAINER) to run — ' +
    'each run creates one real account';

  test('Individual sign-up / email verification via UI lands with a personal org', async ({
    browser,
  }) => {
    // The suite default is 120s, and `waitForVerificationCode` alone budgets DEFAULT_TIMEOUT_MS =
    // 120_000 (mailbox.mjs) — so on a perfectly healthy site the mail poll can consume the entire
    // test before the form is even submitted, and the failure looks like a product bug rather than
    // a budget one. Give the whole arc (register → deliver → poll IMAP → verify → land) room.
    test.setTimeout(240_000);
    test.skip(!config.signup.enabled, SIGNUP_SKIP_REASON);
    const guest = await browser.newContext();
    const gp = await guest.newPage();
    try {
      const address = await signUpThroughTheUi(gp, { kind: 'individual' });
      // The personal org is named from the display name, with no extra step asked of the person.
      await expectOrgListed(gp, 'QA Signup', 'personal');
      // And it offers to become a business — the conversion path exists for exactly this org.
      await expect(gp.getByTestId('org-convert-submit')).toBeVisible();
      console.log(`[auth] ${address}: individual signup → personal org, end to end through the UI`);
    } finally {
      await guest.close();
    }
  });

  test('Business sign-up / email verification via UI lands with the company org', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    test.skip(!config.signup.enabled, SIGNUP_SKIP_REASON);
    const companyName = `QA Business ${randomBytes(2).toString('hex')}`;
    const guest = await browser.newContext();
    const gp = await guest.newPage();
    try {
      const address = await signUpThroughTheUi(gp, { kind: 'business', companyName });
      await expectOrgListed(gp, companyName, 'business');
      // A business org already is one: nothing to convert.
      await expect(gp.getByTestId('org-convert-submit')).toHaveCount(0);
      console.log(`[auth] ${address}: business signup → "${companyName}", end to end through the UI`);
    } finally {
      await guest.close();
    }
  });

  // No mailbox needed: the form refuses before anything is sent, so no account is created.
  test('Business sign-up without a company name is refused on the form', async ({ browser }) => {
    const guest = await browser.newContext();
    const gp = await guest.newPage();
    try {
      await gp.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
      await gp.getByRole('button', { name: 'Create account' }).first().click();
      await gp.getByTestId('register-kind-business').click();
      await gp.getByLabel('Name').fill('QA Signup');
      await gp.getByLabel('Email').fill(`refused-${randomBytes(4).toString('hex')}@stewra.invalid`);
      await gp.getByLabel('Password').fill(`${randomBytes(9).toString('base64url')}-9`);
      await expect(gp.getByTestId('register-company-name')).toBeVisible();
      await gp.getByRole('button', { name: 'Create account' }).last().click();

      await expect(gp.getByText('Tell us the company name')).toBeVisible();
      // Still on the form — the refusal happened client-side, nothing was submitted.
      expect(pathOf(gp)).toBe('/login');
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
