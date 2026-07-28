// One-time QA account bootstrap — drives the REAL website in headless Chromium.
//
// The web + mobile e2e suites both need two email-verified users who are mutual contacts.
// This creates them the way a person would: register on /login, read the 6-digit code out of
// the mailbox, verify on /verify-email, then invite + accept on /contacts. No API shortcuts,
// no direct DB writes.
//
//   E2E_WEB_URL=https://www.stewra.com \
//   E2E_SIGNUP_MAILBOX=qa-e2e@stewra.com \
//   E2E_SIGNUP_SSH_HOST=home \
//   E2E_SIGNUP_IMAP_CONTAINER=mailu-imap-1 \
//   QA_TAG=q3 \
//     node bootstrap-qa-users.mjs
//
// Nothing is defaulted. QA_TAG in particular is required rather than guessed: it names the
// pair (`<mailbox-local>+<tag>a@…` / `…+<tag>b@…`), and reusing a tag fails at registration —
// which is the safe outcome, since accounts cannot be deleted afterwards (`audit_log`
// references `users` with ON DELETE SET NULL and the append-only trigger rejects that UPDATE).
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// From @playwright/test rather than the bare `playwright` package: that one is only present
// transitively here, so importing it directly would break on a stricter install layout.
import { chromium } from '@playwright/test';
import { plusAddress, waitForVerificationCode } from './mailbox.mjs';

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.e2e');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[bootstrap] missing required environment variable ${name} — see the header.`);
  }
  return value;
}

const WEB = requiredEnv('E2E_WEB_URL').replace(/\/$/, '');
const MAILBOX = requiredEnv('E2E_SIGNUP_MAILBOX');
const SSH_HOST = requiredEnv('E2E_SIGNUP_SSH_HOST');
const IMAP_CONTAINER = requiredEnv('E2E_SIGNUP_IMAP_CONTAINER');
const TAG = requiredEnv('QA_TAG');

const users = {
  a: { email: plusAddress(MAILBOX, `${TAG}a`), name: 'QA Web A', password: newPassword() },
  b: { email: plusAddress(MAILBOX, `${TAG}b`), name: 'QA Web B', password: newPassword() },
};

function newPassword() {
  // Long, random, and free of shell/env-file metacharacters (it gets written to .env.e2e).
  return `Qa-${randomBytes(12).toString('base64url')}-9`;
}

function writeEnvFile() {
  const body =
    `# Stewra E2E credentials — QA accounts created through the real UI by\n` +
    `# website/e2e/bootstrap-qa-users.mjs. Gitignored; never commit.\n` +
    `# Mail for both lands in the ${MAILBOX} Mailu mailbox via plus-addressing.\n` +
    `E2E_WEB_URL=${WEB}\n` +
    `E2E_USER_A_EMAIL=${users.a.email}\n` +
    `E2E_USER_A_PASSWORD=${users.a.password}\n` +
    `E2E_USER_B_EMAIL=${users.b.email}\n` +
    `E2E_USER_B_PASSWORD=${users.b.password}\n` +
    `E2E_CONTACT_NAME=${users.b.name}\n`;
  writeFileSync(ENV_PATH, body, { mode: 0o600 });
  console.log(`[bootstrap] credentials written to ${ENV_PATH}`);
}

async function registerAndVerify(browser, user) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  console.log(`[bootstrap] registering ${user.email}`);
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create account' }).first().click();
  await page.getByLabel('Name').fill(user.name);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);

  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.waitForURL(/\/verify-email/, { timeout: 30_000 });
  console.log('[bootstrap]   registered, waiting for the emailed code…');

  const code = await waitForVerificationCode({
    sshHost: SSH_HOST,
    imapContainer: IMAP_CONTAINER,
    mailbox: MAILBOX,
    address: user.email,
  });
  console.log(`[bootstrap]   code ${code} received`);
  await page.getByPlaceholder('000000').fill(code);
  await page.getByRole('button', { name: /verify/i }).click();
  await page.waitForURL(/\/today/, { timeout: 30_000 });
  console.log('[bootstrap]   verified');

  return { ctx, page };
}

const browser = await chromium.launch();
try {
  const a = await registerAndVerify(browser, users.a);
  const b = await registerAndVerify(browser, users.b);

  // Persist before the contact step: the accounts exist and are verified from here on, and
  // their passwords are unrecoverable if this process dies holding them in memory (the login
  // page has no forgot-password link).
  writeEnvFile();

  // Link them as contacts through the UI. Non-fatal: the suite's worker fixture
  // (ensureContacts in lib.mjs) also establishes the pair over the API, so a failure here
  // doesn't block a run.
  try {
    console.log('[bootstrap] A invites B');
    await a.page.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    // NOT getByPlaceholder(/email/i) — "Search by name or email" would match first.
    await a.page.getByPlaceholder('name@example.com').fill(users.b.email);
    await a.page.getByRole('button', { name: 'Send invite' }).click();
    await a.page.getByText(/Invite sent to/i).waitFor({ timeout: 20_000 });

    console.log('[bootstrap] B accepts');
    await b.page.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await b.page.getByRole('button', { name: 'Accept' }).first().click();
    await b.page.getByText(users.a.name).first().waitFor({ timeout: 20_000 });
  } catch (err) {
    console.warn(
      `[bootstrap] UI contact link failed (${err.message.split('\n')[0]}) — ` +
        `the suite fixture will pair them over the API instead.`,
    );
  }

  console.log(`\n[bootstrap] done — ${ENV_PATH} written`);
} finally {
  await browser.close();
}
