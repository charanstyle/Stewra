// The audience plane, driven through the real website: contacts and the consent that arrives with
// them, a list upload with its skipped-row report, and the click-to-WhatsApp opt-in links.
//
// Same footing as `commerce.spec.ts`: the browser, the page, the API, the backend, Postgres and the
// job worker are all real; only Meta is a stand-in, at the network boundary (`graphStub.mjs`).
// Every test builds a fresh organization through the UI, so nothing here leans on another test's
// leftovers — and each opens the audience page ON that org through the page's own picker, because
// the QA user accumulates an org per test and nothing may touch the persistent active-org setting
// (see `openOrgPage`).
import { randomUUID } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  WEB,
  connectChannel,
  createOrg,
  openOrgPage,
  setGraphState,
  tokens,
} from './support';

/** Digits unique enough for a phone number: epoch millis truncated to 9 digits. */
function uniqueDigits(): string {
  return String(Date.now()).slice(-9);
}

test.describe('audience', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    const auth = await tokens();
    context = await browser.newContext({
      storageState: {
        cookies: [],
        origins: [
          { origin: WEB, localStorage: [{ name: 'stewra.tokens', value: JSON.stringify(auth) }] },
        ],
      },
      // For the opt-in link test: the page publishes the wa.me URL through the clipboard — that is
      // the whole point of its Copy button — so reading the clipboard back is how the URL is
      // observed the way an operator would use it.
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    page = await context.newPage();
  });

  test.afterEach(async () => {
    await context.close();
  });

  test('a contact added with a consent source appears in the list, opt-in and all', async () => {
    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Contacts ${Date.now()}`);
    await openOrgPage(
      page,
      '/commerce/audience',
      orgId,
      page.getByRole('heading', { name: 'Sending policy', exact: true }),
    );

    const contactName = `Ada Buyer ${randomUUID().slice(0, 6)}`;
    const phone = `+1555${uniqueDigits().slice(0, 6)}0`;
    await page.getByPlaceholder('+44 7700 900123').fill(phone);
    await page.getByPlaceholder('Name (optional)').fill(contactName);
    await page.getByPlaceholder('Tags, comma separated').fill('vip');

    // Before the box is ticked, the page says plainly what omitting consent means. Asserted because
    // this sentence is the difference between "optional field" and "informed choice".
    await expect(
      page.getByText(/Without an opt-in on file this contact can be tagged and segmented/),
    ).toBeVisible();

    await page.getByText('This person has given marketing opt-in').click();
    // The source names which kind of proof this is; the evidence field is required with it.
    await page
      .locator('select')
      .filter({ hasText: 'Sign-up form' })
      .selectOption({ label: 'Clicked an ad' });
    await page
      .getByPlaceholder('Where it came from — a form URL, ad id, or list name')
      .fill('meta ad 4471 · click 2026-08-14');

    await page.getByRole('button', { name: 'Add contact' }).click();
    await expect(page.getByText(`${phone} added with marketing opt-in recorded.`)).toBeVisible();

    // The contact is in the list, wearing its tag; opening it shows the consent trail with the
    // source that was chosen, not a default.
    const row = page.getByRole('button', { name: new RegExp(contactName) });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByText(/marketing: opted_in · via ad_click/)).toBeVisible();
    await expect(page.getByText(/meta ad 4471/)).toBeVisible();
  });

  test('a CSV import lands its good rows as contacts and reports the bad row, unimported', async () => {
    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Import ${Date.now()}`);
    await openOrgPage(
      page,
      '/commerce/audience',
      orgId,
      page.getByRole('heading', { name: 'Sending policy', exact: true }),
    );

    // Two rows carrying full consent provenance plus an attribute column, and one row whose phone
    // is not a phone. The bad row must be REPORTED, not repaired and not silently dropped — a list
    // is only lawful to message if every number on it survived this exact judgement.
    const digits = uniqueDigits();
    const goodOne = `+1555${digits.slice(0, 5)}01`;
    const goodTwo = `+1555${digits.slice(0, 5)}02`;
    const csv = [
      'phone,name,tags,consent_purpose,consent_state,consent_source,consent_evidence,city',
      `${goodOne},Csv One,newsletter,marketing,opted_in,import,spring-2026-list.csv,Lisbon`,
      `${goodTwo},Csv Two,newsletter,marketing,opted_in,import,spring-2026-list.csv,Porto`,
      'not-a-phone,Csv Broken,newsletter,marketing,opted_in,import,spring-2026-list.csv,Faro',
    ].join('\n');

    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    // The import is queued, run by the real worker, and the page polls it to completion — so this
    // waits for the FINAL report, not the upload's 202.
    await expect(page.getByText(/Done\. 2 imported, 1 skipped\./)).toBeVisible({
      timeout: 30_000,
    });

    // The skipped row is findable in the operator's own spreadsheet: row number, the number as they
    // wrote it, and the sentence saying what is wrong with it.
    await expect(page.getByText('Row 3: not-a-phone')).toBeVisible();
    await expect(page.getByText(/Include the country code/)).toBeVisible();

    // The good rows are real contacts now, and their consent arrived with them.
    const imported = page.getByRole('button', { name: /Csv One/ });
    await expect(imported).toBeVisible();
    await expect(page.getByRole('button', { name: /Csv Two/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Csv Broken/ })).toHaveCount(0);
    await imported.click();
    await expect(page.getByText(/marketing: opted_in · via import/)).toBeVisible();
  });

  test('an opt-in link mints against the connected number and hands over its wa.me URL', async () => {
    const wabaId = `waba-optin-${Date.now()}`;
    await setGraphState({ wabaId, phoneStatus: 'CONNECTED' });

    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Optin ${Date.now()}`);
    // A link has to open a chat with something, so the number is connected first — through the same
    // API surface that stands in for Meta's Embedded Signup dialog everywhere in this suite.
    await connectChannel(orgId, 'e2e-code-optin');

    await openOrgPage(
      page,
      '/commerce/audience',
      orgId,
      page.getByRole('heading', { name: 'Sending policy', exact: true }),
    );

    const linkName = `Receipt QR ${randomUUID().slice(0, 6)}`;
    const phrase = 'Yes, please send me offers and updates';
    // One connected number, so the channel select arrives preselected — asserted rather than
    // assumed, because a link pointing at the wrong number would be printed before anyone noticed.
    await expect(
      page.locator('select').filter({ hasText: '+1 555 010 0100' }),
    ).toHaveValue(/.+/);
    await page.getByPlaceholder('Name it — Receipt QR, Website footer').fill(linkName);
    await expect(page.getByPlaceholder('The message they will send')).toHaveValue(phrase);
    await page.getByRole('button', { name: 'Create link' }).click();

    await expect(page.getByText(`"${linkName}" is live.`, { exact: false })).toBeVisible();

    // The row shows the sentence the customer will send — with the server-appended reference code
    // that ties a future opt-in back to this link — and zero opt-ins so far, honestly counted.
    await expect(page.getByText(new RegExp(`${phrase} \\[[A-Za-z0-9]+\\]`))).toBeVisible();
    await expect(page.getByText(new RegExp(`${linkName} — 0 opt-ins`))).toBeVisible();

    // The URL itself leaves through the Copy button — that is the artifact an operator pastes into
    // a QR generator — so it is read back from where the page actually put it.
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^https:\/\/wa\.me\/15550100100\?text=/);
    // The prefilled text rides inside the URL, encoded — the phrase is the evidence, so the link
    // must actually carry it.
    expect(decodeURIComponent(copied)).toContain(phrase);
  });
});
