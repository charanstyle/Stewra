// Account deletion, driven entirely through the UI against whatever E2E_WEB_URL names — production
// by default, which is the only place the promise actually has to hold.
//
// This test creates its own account and destroys it. That is not squeamishness about touching prod:
// `delete-account-confirm` is irreversible with no grace period and no restore, so pointing it at a
// shared QA account would end the rest of the suite. A throwaway registered seconds earlier is the
// only honest subject.
//
// The first test needs no `E2E_SIGNUP_MAILBOX`, unlike the sign-up test in auth.spec.ts: deletion is
// deliberately NOT behind email verification (see `backend/src/routes/users.ts` — an unverified
// account is still an account with data in it, and gating erasure on finishing onboarding would be a
// trap), so a plain account can be created and erased without ever reading the emailed code.
//
// The two organization cases below DO need it. Creating an org is behind `requireEmailVerification`,
// so the only way to reach them through the UI is to read the code out of the real mailbox — and the
// sole-owner case additionally needs a second person, which means reading an invite email too.
//
// Addresses are plus-addressed off the QA mailbox rather than an @invalid domain: the mail Stewra
// sends then lands somewhere real instead of failing to resolve and raising a Sentry event per run.
import { randomBytes } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { WEB } from '../lib.mjs';
import { config } from '../config.mjs';
import { plusAddress, waitForVerificationCode, waitForInviteAcceptPath } from '../mailbox.mjs';

function pathOf(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return page.url();
  }
}

/**
 * A fresh, deliverable address and a password that satisfies the register form's 8-char minimum.
 *
 * Plus-addressed off the QA sign-up mailbox when one is configured — that is the mailbox whose
 * maildir the tests below actually read. Without it there is nothing to read, so any deliverable
 * address will do and QA user A's is the one this suite is guaranteed to have.
 */
function newIdentity(tag: string): { address: string; password: string } {
  const base = config.signup.enabled ? config.signup.mailbox : config.users.a.email;
  return {
    address: plusAddress(base, `${tag}${randomBytes(4).toString('hex')}`),
    password: `Qa-${randomBytes(12).toString('base64url')}-9`,
  };
}

interface Actor {
  readonly page: Page;
  readonly address: string;
  readonly password: string;
  /** Alerts the page raised — a deletion warns here about grants it could not confirm revoked. */
  readonly alerts: string[];
  close: () => Promise<void>;
}

/** Register through the login form. Lands on /verify-email, which is where a real sign-up lands. */
async function register(browser: Browser, tag: string, displayName: string): Promise<Actor> {
  const { address, password } = newIdentity(tag);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const alerts: string[] = [];
  page.on('dialog', (dialog) => {
    alerts.push(dialog.message());
    void dialog.accept();
  });

  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create account' }).first().click();
  await page.getByLabel('Name').fill(displayName);
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password').fill(password);
  // .last() — the mode tab and the submit button share this accessible name.
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.waitForURL(/\/verify-email/, { timeout: 30_000 });
  console.log(`[deletion] registered ${address}`);

  return { page, address, password, alerts, close: () => ctx.close() };
}

/** Read the emailed code the way its owner would, and type it in. Required before creating an org. */
async function verifyEmail(actor: Actor): Promise<void> {
  const code = await waitForVerificationCode({
    sshHost: config.signup.sshHost,
    imapContainer: config.signup.imapContainer,
    mailbox: config.signup.mailbox,
    address: actor.address,
  });
  expect(code, 'emailed verification code').toMatch(/^\d{6}$/);
  await actor.page.getByPlaceholder('000000').fill(code);
  await actor.page.getByRole('button', { name: /verify/i }).click();
  await actor.page.waitForURL(/\/today/, { timeout: 30_000 });
}

/** Create an organization on /commerce. The actor becomes its owner and only member. */
async function createOrg(actor: Actor, name: string): Promise<void> {
  await actor.page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
  await actor.page.getByPlaceholder('New organization name').fill(name);
  await actor.page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(actor.page.getByText(`Created ${name}. You are its owner.`)).toBeVisible();
}

/** Open Settings → Danger zone → Delete account. Returns once the server's preview has rendered. */
async function openDeletionSheet(actor: Actor): Promise<void> {
  await actor.page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
  await expect(actor.page.getByRole('heading', { name: 'Danger zone' })).toBeVisible();
  await actor.page.getByTestId('settings-delete-account').click();
  // The Cancel button belongs to the sheet and renders whether or not deletion is allowed, so it —
  // not the password field — is what proves the preview came back.
  await expect(actor.page.getByRole('button', { name: 'Cancel' })).toBeVisible();
}

/** Confirm the deletion and wait for the app to have nowhere to put us but /login. */
async function confirmDeletion(actor: Actor): Promise<void> {
  await actor.page.getByTestId('delete-account-password').fill(actor.password);
  const confirm = actor.page.getByTestId('delete-account-confirm');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await actor.page.waitForURL('**/login', { timeout: 60_000 });
  console.log(`[deletion] deleted ${actor.address} through the UI`);
}

/**
 * Best-effort removal of an account a failing assertion left behind, mirroring the cleanup in
 * `backend/src/tests/accountDeletion.test.ts`. Swallowing the error is right here and only here:
 * this runs in a `finally`, the account may already be gone, and throwing would replace the real
 * failure with a cleanup one. It is not a fallback for the assertions above — none of them are
 * satisfied by it, and a run where this is what deleted the account still fails.
 *
 * It matters more than usual because these accounts are real and on production: without it, every
 * mid-test failure strands a user (and possibly an organization) that nobody has the password for —
 * the website has no password-reset UI, so an orphan cannot be cleaned up through the UI at all.
 */
async function deleteIfPresent(actor: Actor): Promise<void> {
  try {
    await openDeletionSheet(actor);
    await confirmDeletion(actor);
    console.log(`[deletion] cleaned up ${actor.address}`);
  } catch {
    // Already deleted, blocked, or the page never got there. Nothing further this can do.
  }
}

/** The real proof: the credentials that worked a moment ago are refused. */
async function expectSignInRefused(actor: Actor): Promise<void> {
  await actor.page.getByLabel('Email').fill(actor.address);
  await actor.page.getByLabel('Password').fill(actor.password);
  await actor.page.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(actor.page.getByText('Invalid email or password')).toBeVisible();
  expect(pathOf(actor.page), 'a deleted account must not get past /login').toBe('/login');
}

test.describe('account deletion', () => {
  // Google Play's Data safety form requires this URL to open without signing in, and the person most
  // likely to need it is one who can no longer sign in. A redirect to /login here fails the form.
  test('the public /account-deletion page opens signed out', async ({ browser }) => {
    const guest = await browser.newContext();
    const gp = await guest.newPage();
    try {
      await gp.goto(`${WEB}/account-deletion`, { waitUntil: 'domcontentloaded' });
      await expect(gp.getByRole('heading', { name: 'Deleting your account' })).toBeVisible();
      expect(pathOf(gp), 'must not bounce a signed-out visitor to /login').toBe('/account-deletion');
      // The two things the form is really asking about: how to do it, and what survives.
      await expect(gp.getByRole('heading', { name: 'What is deleted' })).toBeVisible();
      await expect(gp.getByRole('heading', { name: 'What is kept, and why' })).toBeVisible();
    } finally {
      await guest.close();
    }
  });

  test('a person can delete their own account, and it is really gone', async ({ browser }) => {
    // Registration + a real deletion round-trip against a live host; the 120s suite default leaves no
    // room for a slow first-paint on a cold code-split chunk.
    test.setTimeout(180_000);

    // The page alerts when a third-party grant could not be confirmed revoked. Captured rather than
    // auto-dismissed: it is the one thing the user must still act on, and it is asserted below.
    const actor = await register(browser, 'del', 'QA Deletion');
    const { page, address, password, alerts } = actor;

    try {
      // Settings renders for an unverified account: `ProtectedRoute` gates on a session, not on
      // verification, and the deletion routes are outside `requireEmailVerification` on purpose.
      await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Danger zone' })).toBeVisible();

      // Opening the sheet fetches the server's preview. It destroys nothing, and the password field
      // does not exist until it has answered — so its appearance IS the preview arriving.
      await page.getByTestId('settings-delete-account').click();
      const passwordField = page.getByTestId('delete-account-password');
      await expect(passwordField).toBeVisible();

      // A brand-new account owns no organization, so nothing may block it. The confirm button is
      // rendered only when `blockers` is empty, which makes its presence the assertion.
      const confirm = page.getByTestId('delete-account-confirm');
      await expect(confirm).toBeVisible();
      await expect(confirm).toBeDisabled(); // no password typed yet

      await passwordField.fill(password);
      await expect(confirm).toBeEnabled();
      await confirm.click();

      // The account is gone: `logout()` clears the session and ProtectedRoute has nowhere to send us
      // but /login. Waiting on that redirect is waiting on the request having succeeded.
      await page.waitForURL('**/login', { timeout: 60_000 });
      expect(pathOf(page)).toBe('/login');
      console.log(`[deletion] deleted ${address} through the UI`);

      // An account with no connections has no third-party grant to revoke, so there is nothing the
      // user could still need to go and switch off by hand.
      expect(alerts, 'unconfirmed-revocation alerts').toEqual([]);

      // The real proof, and the reason this test signs in again rather than trusting the redirect:
      // the credentials that worked a minute ago are now refused. A soft-deleted or half-deleted
      // account would sign straight back in here.
      await page.getByLabel('Email').fill(address);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Sign in' }).last().click();
      await expect(page.getByText('Invalid email or password')).toBeVisible();
      expect(pathOf(page), 'a deleted account must not get past /login').toBe('/login');
    } finally {
      await actor.close();
    }
  });

  // The two cases below are what migration 062 was really for: `organizations.created_by` was
  // `NOT NULL … ON DELETE RESTRICT`, so anyone who had ever created an org could not be deleted at
  // all. Reaching them through the UI means a verified account, which means reading real email.
  test.describe('with an organization', () => {
    // No retry. Everything these tests create is real and on production, so a retry does not get a
    // second chance at the same state — it creates a whole second set of accounts and organizations
    // next to the ones the failed attempt is still holding.
    test.describe.configure({ retries: 0 });

    test.beforeEach(() => {
      test.skip(
        !config.signup.enabled,
        'set E2E_SIGNUP_MAILBOX (+ E2E_SIGNUP_SSH_HOST, E2E_SIGNUP_IMAP_CONTAINER) — creating an ' +
          'org needs a verified email, and verifying one means reading the emailed code',
      );
    });

    test('an organization you are the only member of is destroyed with you', async ({ browser }) => {
      // Sign-up + a mail round-trip + org creation + deletion, all against a live host.
      test.setTimeout(300_000);
      const orgName = `QA Solo ${randomBytes(3).toString('hex')}`;

      const owner = await register(browser, 'solo', 'QA Solo Owner');
      try {
        await verifyEmail(owner);
        await createOrg(owner, orgName);

        await openDeletionSheet(owner);
        // Nobody else can ever reach this tenant's data again, so it goes with the account — and the
        // user is told so before they type a password, not after.
        await expect(owner.page.getByText('These will be deleted with you')).toBeVisible();
        await expect(
          owner.page.getByText(new RegExp(`${orgName}.*only member`)),
        ).toBeVisible();

        await confirmDeletion(owner);
        await expectSignInRefused(owner);
      } finally {
        await deleteIfPresent(owner);
        await owner.close();
      }
    });

    test('the sole owner of an org with other members is refused, and told why', async ({
      browser,
    }) => {
      // Two sign-ups, three mail round-trips (two codes + one invite) and three deletions.
      test.setTimeout(600_000);
      const orgName = `QA Team ${randomBytes(3).toString('hex')}`;

      const owner = await register(browser, 'owner', 'QA Team Owner');
      const member = await register(browser, 'member', 'QA Team Member');
      try {
        await verifyEmail(owner);
        await createOrg(owner, orgName);

        // Invite the second person at the default role (`agent`) — enough to be a member, not enough
        // to be an owner, which is exactly the situation the refusal exists for.
        await owner.page.goto(`${WEB}/commerce/team`, { waitUntil: 'domcontentloaded' });
        await owner.page.getByPlaceholder('colleague@example.com').fill(member.address);
        await owner.page.getByRole('button', { name: 'Send invite' }).click();
        // Plain string, not a RegExp: a plus-addressed mailbox contains `+`, which a RegExp reads as
        // a quantifier — the notice renders and the locator silently fails to match it.
        await expect(owner.page.getByText(`Invite emailed to ${member.address}`)).toBeVisible();

        // The invitee reads their own mail and follows the link, as a colleague would. Accepting is a
        // deliberate click, not a side effect of opening the email.
        await verifyEmail(member);
        const acceptPath = await waitForInviteAcceptPath({
          sshHost: config.signup.sshHost,
          imapContainer: config.signup.imapContainer,
          mailbox: config.signup.mailbox,
          address: member.address,
        });
        await member.page.goto(`${WEB}${acceptPath}`, { waitUntil: 'domcontentloaded' });
        await member.page.getByRole('button', { name: 'Accept invitation' }).click();
        await expect(member.page.getByText(new RegExp(`You've joined ${orgName}`))).toBeVisible();

        // The refusal. Not "resolved" for them by promoting somebody or destroying other people's
        // work — both are the user's call, and both are one action away.
        await openDeletionSheet(owner);
        await expect(owner.page.getByText(new RegExp(`only owner of .${orgName}.`))).toBeVisible();
        await expect(owner.page.getByText(/Make someone else an owner first/)).toBeVisible();
        // Blocked means there is no way to proceed at all — the confirm button and the password field
        // are not rendered, so this cannot be defeated by clicking anyway.
        await expect(owner.page.getByTestId('delete-account-confirm')).toHaveCount(0);
        await expect(owner.page.getByTestId('delete-account-password')).toHaveCount(0);

        // Clear the blocker the way the message says to — here by the member leaving, which is itself
        // a deletion of somebody who is a member but not the last owner, and must be allowed.
        await openDeletionSheet(member);
        await expect(member.page.getByText(new RegExp(`You will be removed from: ${orgName}`))).toBeVisible();
        await confirmDeletion(member);

        // Same account, same org, one member fewer: now it is allowed, and the org goes along.
        await openDeletionSheet(owner);
        await expect(owner.page.getByText('These will be deleted with you')).toBeVisible();
        await expect(owner.page.getByText(new RegExp(`${orgName}.*only member`))).toBeVisible();
        await confirmDeletion(owner);
        await expectSignInRefused(owner);
      } finally {
        // Member first: while they are still in the org, the owner is the sole owner and blocked.
        await deleteIfPresent(member);
        await deleteIfPresent(owner);
        await owner.close();
        await member.close();
      }
    });
  });
});
