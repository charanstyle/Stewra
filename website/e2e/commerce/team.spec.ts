// The team plane, driven through the real website: who is in the organization, and the invite that
// brings the next person in.
//
// Same footing as `commerce.spec.ts`. One extra piece of the stack matters here: the invite's
// accept link leaves through the backend's REAL nodemailer transport, and a failed delivery
// revokes the invite by design — so the stack runs an SMTP sink (`mailSink.mjs`) for the mail to
// land in. The sink keeps nothing, which this file's reach reflects honestly:
//
// NOT COVERED HERE: accepting the invite. Two public-surface walls, either of which is enough.
// The accept token exists only inside the email (the API never returns it, correctly — it is the
// credential), and the sink discards the mail. And even with the token in hand, acceptance sits
// behind the email-verification gate, which only the stack's boot-time database flip can satisfy —
// a spec has no database access, so it cannot mint a second verified account to accept as.
// What IS coverable is asserted below: the invite is created, announced, listed as pending with
// its role and expiry, and revocable.
import { randomUUID } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { WEB, createOrg, openOrgPage, tokens } from './support';

test.describe('team', () => {
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
    });
    page = await context.newPage();
  });

  test.afterEach(async () => {
    await context.close();
  });

  test('an invite is emailed, listed as pending with its role, and revocable', async () => {
    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Team ${Date.now()}`);
    await openOrgPage(
      page,
      '/commerce/team',
      orgId,
      page.getByRole('heading', { name: 'Members', exact: true }),
    );

    // The founder is already on the members list, at the role the server granted — owner is not a
    // UI default, it is what creating the org made them.
    const membersCard = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Members', exact: true }) });
    await expect(membersCard.getByText('Commerce QA')).toBeVisible();
    await expect(membersCard.locator('select')).toHaveValue('owner');

    const inviteCard = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Invite someone', exact: true }) });
    const inviteEmail = `colleague+${randomUUID().slice(0, 8)}@stewra.test`;
    await inviteCard.getByPlaceholder('colleague@example.com').fill(inviteEmail);
    // 'agent' is the form's default; chosen explicitly so the assertion below tests the role that
    // was PICKED, not whatever the default happens to be next quarter.
    await inviteCard.locator('select').selectOption('agent');
    await inviteCard.getByRole('button', { name: 'Send invite' }).click();

    // The notice is the server's word that the email actually left — on a delivery failure the
    // backend revokes the invite and this text never appears, which is exactly the honesty the
    // stack's SMTP sink exists to let through.
    await expect(page.getByText(`Invite emailed to ${inviteEmail}.`, { exact: false })).toBeVisible();
    await expect(page.getByText(/It grants agent and expires/)).toBeVisible();

    // The pending invite renders with everything an admin needs to audit it: address, role, expiry.
    const pendingRow = inviteCard.locator('div').filter({ hasText: inviteEmail }).last();
    await expect(pendingRow).toBeVisible();
    await expect(pendingRow.getByText('agent', { exact: true })).toBeVisible();
    await expect(pendingRow.getByText(/expires/)).toBeVisible();

    // And it can be taken back before anyone accepts it.
    await pendingRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(inviteCard.getByText(inviteEmail)).toHaveCount(0);
  });
});
