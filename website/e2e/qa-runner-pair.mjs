#!/usr/bin/env node
// Mint a runner pairing code for one of the QA accounts, through the screens.
//
// The QA virtual machines (the Linux guest on stewra-server, the macOS guest on the Mac mini) are
// paired the way a customer pairs a laptop: sign in, open /fleet, press "Pair a machine", copy the
// command. Nothing here touches the API directly — see structure.mjs for the same discipline on the
// business account.
//
//   node qa-runner-pair.mjs A     mint a code in QA user A's active organization (prints CODE=…)
//   node qa-runner-pair.mjs B     same for QA user B
//
// The code lands in whichever organization /fleet opens on, which is the account's ACTIVE org — the
// one GET /runner/devices lists for, and therefore the one runner.spec.ts discovers machines in.
// The selected org is printed so a surprise is visible, not silent.
import { chromium } from 'playwright';
import { env, required } from './env.mjs';

const WEB = required(env.E2E_WEB_URL, 'E2E_WEB_URL').replace(/\/$/, '');
const TIMEOUT = 20_000;

const who = process.argv[2];
if (who !== 'A' && who !== 'B') {
  console.error('usage: node qa-runner-pair.mjs A|B');
  process.exit(2);
}
const EMAIL = required(env[`E2E_USER_${who}_EMAIL`], `E2E_USER_${who}_EMAIL`);
const PASSWORD = required(env[`E2E_USER_${who}_PASSWORD`], `E2E_USER_${who}_PASSWORD`);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await page.waitForURL(/\/(today|chats)/, { timeout: 30_000 });
  console.log(`[qa-pair] signed in as ${EMAIL}`);

  await page.goto(`${WEB}/fleet`, { waitUntil: 'domcontentloaded' });
  const select = page.getByTestId('fleet-org-select');
  await select.waitFor({ timeout: TIMEOUT });
  const selected = select.locator('option:checked');
  const orgLabel = ((await selected.textContent()) ?? '').trim();
  if (orgLabel.length === 0) {
    throw new Error('the fleet page has no organization selected');
  }
  console.log(`[qa-pair] fleet is showing: ${orgLabel}`);

  await page.getByTestId('fleet-matrix').or(page.getByTestId('fleet-pair')).first().waitFor({ timeout: TIMEOUT });
  await page.getByTestId('fleet-pair').click();
  const block = page.getByTestId('fleet-pair-code');
  await block.waitFor({ timeout: TIMEOUT });
  // Exact backend format (runnerDeviceRepository): STEWRA- + 8 chars of the ambiguity-free alphabet.
  const text = (await block.textContent()) ?? '';
  const match = /stewra-runner pair\s+(STEWRA-[ACDEFGHJKLMNPQRTUVWXYZ2346789]{8})/.exec(text);
  if (match === null) {
    throw new Error(`pairing block does not show a command: ${text.slice(0, 200)}`);
  }
  console.log(`CODE=${match[1]}`);
} finally {
  await browser.close();
}
