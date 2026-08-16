// The billing page, driven through the real website: what an org is on, who charges it, and what
// it owes — plus the two states where showing a way to pay would be a bug rather than a feature.
//
// Same footing as the rest of this suite: real browser, real website, real backend, real Postgres,
// and the real `commerce_jobs` worker and scheduler. Nothing about money is simulated here. The
// invoice these tests wait for is issued by the actual hourly billing sweep (turned down to two
// seconds by the stack, which changes when it runs and nothing about what it does), by the actual
// period-close job, out of the actual plan version the org was frozen against.
//
// WHAT IS NOT HERE: typing a card. That field is an iframe served by js.stripe.com and confirmed by
// Stripe's own script against a publishable key, so it cannot be pointed at a stand-in and a fake
// key is rejected before it renders. Card entry and the charge that follows it live in
// `card.stripe.ts`, which runs under `playwright.stripe.config.ts` and refuses to start without
// Stripe TEST keys. Splitting it out rather than skipping it keeps this file's skip budget at zero:
// a suite that provisions everything it needs has no legitimate reason to skip.
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  BILLING_PROVIDER,
  WEB,
  backdateSubscription,
  billingLoaded,
  billingPlan,
  createOrg,
  openOrgPage,
  reloadBillingUntil,
  subscribeOrg,
  tokens,
} from './support';

/** The `<section>` card under the given heading. The page repeats copy shapes across cards. */
function card(page: Page, heading: string): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
}

/** The Plan card always renders, on every org and every provider — so it is the readiness signal. */
function planCard(page: Page): Locator {
  return card(page, 'Plan');
}

function invoiceRows(page: Page): Locator {
  return card(page, 'Invoices').locator('li');
}

test.describe('billing', () => {
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

  test('an organization on no plan is told so plainly, and is charged nothing', async () => {
    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Unplanned ${Date.now()}`);

    await openOrgPage(page, '/commerce/billing', orgId, planCard(page));
    // Before any assertion: every empty state below is also this page's initial state, so without
    // this the whole test would pass against a billing call that was never made.
    await billingLoaded(page);

    await expect(
      page.getByText('This organization is not on a plan yet. Nothing is being charged.'),
    ).toBeVisible();
    await expect(page.getByText('No invoices yet.')).toBeVisible();
    // No plan means nobody collects, so no invoice may exist — not even a draft one. An org that
    // has agreed to nothing being billed for something is the failure this asserts against.
    await expect(invoiceRows(page)).toHaveCount(0);
  });

  test('a web subscriber sees the fee it agreed to, at the version it was frozen at, and is invoiced in advance', async () => {
    const plan = await billingPlan();

    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Web Billed ${Date.now()}`);
    await subscribeOrg({ orgId, planId: plan.id, collector: 'stewra_stripe' });
    // In advance means a period bills only a subscription that predates it, so a run on any day but
    // the 1st sees no invoice at all without this. See `backdateSubscription`.
    await backdateSubscription(orgId);

    await openOrgPage(page, '/commerce/billing', orgId, planCard(page));

    // The amount is asserted without its currency symbol on purpose: `formatMicros` renders through
    // `Intl` with the browser's locale, so the grouping and the symbol are the runner's business
    // and the number is the product's.
    await expect(planCard(page)).toContainText(plan.name);
    await expect(planCard(page)).toContainText(/149[.,]00/);
    await expect(planCard(page)).toContainText('per month, charged in advance');
    // Version 1 because the plan name is minted per run. A subscriber's price is frozen to the
    // version in force when they joined, so this is the number that must never drift under them.
    await expect(planCard(page)).toContainText('Version 1');
    // No store note: Stewra collects this one, and saying otherwise would send the customer to
    // Apple to cancel something Apple has never heard of.
    await expect(planCard(page)).not.toContainText('Apple bills this subscription');
    await expect(planCard(page)).not.toContainText('Google Play bills this subscription');

    // The real scheduler, the real close job, the real plan version — a $149 invoice for the month
    // ahead, appearing in the list the customer reads.
    await reloadBillingUntil(
      page,
      orgId,
      planCard(page),
      invoiceRows(page).first(),
      'an invoice for the current period',
    );
    await expect(invoiceRows(page)).toHaveCount(1);
    await expect(invoiceRows(page).first()).toContainText(/149[.,]00/);
    // The period it covers, named as a month rather than a date range — matched loosely because
    // the month name is the runner's locale, and which month it is, is the calendar's business.
    await expect(invoiceRows(page).first()).toContainText(/\p{L}+ \d{4}/u);
    // Issued and uncollected: this org never added a card, so nothing may charge it. The page
    // derives delinquency
    // from that rather than storing it, and says what happens next in the customer's own terms.
    await expect(invoiceRows(page).first()).toContainText('issued');
    await expect(page.getByText(/An invoice is unpaid\. Sending stops if it is still outstanding/)).toBeVisible();

    // Under `manual` there is no card to add and the page says so instead of offering one. Under
    // `stripe` the card section is what `card.stripe.ts` drives; either way the assertion is
    // against the provider the stack actually booted on, not against whichever branch rendered.
    if (BILLING_PROVIDER === 'manual') {
      await expect(page.getByText('This installation settles invoices offline')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add a card' })).toHaveCount(0);
    } else {
      await expect(page.getByRole('button', { name: /Add a card|Replace card/ })).toBeVisible();
      await expect(page.getByText('This installation settles invoices offline')).toHaveCount(0);
    }
  });

  test('an App Store subscriber is never offered a way to pay Stewra, and is never invoiced', async () => {
    const plan = await billingPlan();

    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Apple Billed ${Date.now()}`);
    await subscribeOrg({ orgId, planId: plan.id, collector: 'apple' });
    // Backdated exactly like the web subscriber above, so this test differs from that one in ONE
    // thing: who collects. Without it, "no invoice" would be true for the boring reason.
    await backdateSubscription(orgId);

    await openOrgPage(page, '/commerce/billing', orgId, planCard(page));

    await expect(planCard(page)).toContainText(plan.name);
    await expect(planCard(page)).toContainText('Apple bills this subscription');
    await expect(planCard(page)).toContainText('Stewra never charges this card');

    // The whole point. Both branches of the payment-method section are suppressed — the Stripe one
    // because a second card charge for a month Apple has already taken is a duplicate, and the
    // manual one because "pay the invoice by transfer" is a duplicate with no provider to reverse
    // it. Asserting on the heading covers both branches with one locator, so a future third branch
    // that forgets the guard fails here too.
    await expect(page.getByRole('heading', { name: 'Payment method' })).toHaveCount(0);
    await expect(page.getByText('This installation settles invoices offline')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Add a card|Replace card/ })).toHaveCount(0);

    await expect(
      page.getByText('None — the App Store or Google Play issues the receipts for this subscription.'),
    ).toBeVisible();

    // And it stays that way through the sweeps. A store-collected period closes producing no
    // invoice at all, which is the correct number of invoices; a single one here would be a
    // customer billed twice for the same month by two companies that cannot see each other.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await openOrgPage(page, '/commerce/billing', orgId, planCard(page));
    await billingLoaded(page);
    await expect(invoiceRows(page)).toHaveCount(0);
  });
});
