// Money, moved. A card typed into Stripe's own iframe, put on file through the real SetupIntent
// flow, and then charged for a real $149 invoice — all through the page, all in Stripe test mode.
//
// This is the one file in the repo where Stripe is not stood in for. `commercePayments.test.ts`
// proves the server's half against a scripted stand-in: the idempotency key on the wire, the race
// between two collectors, the declined charge, the webhook signature over raw bytes. None of that
// can prove a customer can actually put a card on file, because the card never reaches the server —
// it goes from the browser to js.stripe.com, and what comes back is a setup id the server then
// re-reads from Stripe. The only way to test that path is to be Stripe's customer.
//
// Runs under `playwright.stripe.config.ts`, which refuses to start without TEST-mode keys in
// backend/.env.test. See that file for why it is separate from the commerce suite.
import { test, expect, type BrowserContext, type FrameLocator, type Locator, type Page } from '@playwright/test';
import {
  WEB,
  apiCall,
  backdateSubscription,
  billingLoaded,
  billingPlan,
  createOrg,
  openOrgPage,
  reloadBillingUntil,
  subscribeOrg,
  tokens,
} from './support';

/**
 * Stripe's universally-accepted test card. Any future expiry and any CVC are valid in test mode;
 * the date is written as a fixed far-future one rather than derived from the clock, because a
 * derived date is a second thing that can be wrong on the day this fails.
 */
const TEST_CARD = { number: '4242424242424242', expiry: '12 / 34', cvc: '123', postal: '12345' };

function card(page: Page, heading: string): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
}

function planCard(page: Page): Locator {
  return card(page, 'Plan');
}

function invoiceRows(page: Page): Locator {
  return card(page, 'Invoices').locator('li');
}

/**
 * Stripe's card Element, which mounts as an iframe whose name begins `__privateStripeFrame`.
 *
 * Located by that prefix rather than by index: the page can carry a second, hidden Stripe frame
 * (their controller frame is always present once the SDK loads), and picking by position would work
 * until the day their script mounts them in the other order.
 */
function cardFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[name^="__privateStripeFrame"]').first();
}

async function fillCard(page: Page): Promise<void> {
  const frame = cardFrame(page);
  // Sequential and awaited: Stripe's combined field advances focus itself as each segment fills,
  // and typing into two of them at once lands characters in whichever has focus at that instant.
  await frame.locator('[name="cardnumber"]').fill(TEST_CARD.number);
  await frame.locator('[name="exp-date"]').fill(TEST_CARD.expiry);
  await frame.locator('[name="cvc"]').fill(TEST_CARD.cvc);
  await frame.locator('[name="postal"]').fill(TEST_CARD.postal);
}

test.describe('stripe card', () => {
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

  test('a card typed into Stripe goes on file, and the next invoice is collected without anyone asking', async () => {
    const plan = await billingPlan();

    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Stripe ${Date.now()}`);
    await subscribeOrg({ orgId, planId: plan.id, collector: 'stewra_stripe' });

    await openOrgPage(page, '/commerce/billing', orgId, planCard(page));
    await billingLoaded(page);

    // Before: no card, and the page says what that means rather than only what is missing.
    await expect(
      page.getByText('No card on file. Invoices will be issued but nothing can be collected'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Add a card' }).click();
    await fillCard(page);
    await page.getByRole('button', { name: 'Save card' }).click();

    await expect(
      page.getByText('Card saved. Invoices are charged automatically from now on.'),
    ).toBeVisible();
    await expect(page.getByText('A card is on file with Stripe.')).toBeVisible();

    // The page's word for it is not the fact. The server was handed only a setup id and went to ask
    // Stripe what that setup attached, so this read is the one that proves a real payment method
    // was stored against a real Stripe customer — not that a button changed its label.
    const billing = await apiCall<{ data: { paymentMethod: { provider: string; stored: boolean } } }>(
      `/orgs/${orgId}/billing`,
    );
    expect(billing.body.data.paymentMethod.provider).toBe('stripe');
    expect(billing.body.data.paymentMethod.stored).toBe(true);

    // Now give it something to collect. Backdated for the same reason as in `billing.spec.ts`: the
    // fee is charged in advance, so a subscription that began today is free until the 1st.
    await backdateSubscription(orgId);

    // From here nothing is driven — the real sweep enqueues the close, the real close job issues
    // the $149 invoice, the real charge job collects it through Stripe, and the page reports `paid`
    // without anyone pressing anything. That silence is the feature.
    await reloadBillingUntil(
      page,
      orgId,
      planCard(page),
      invoiceRows(page).filter({ hasText: 'paid' }).first(),
      'an invoice collected by Stripe',
    );

    const paid = invoiceRows(page).filter({ hasText: 'paid' }).first();
    await expect(paid).toContainText(/149[.,]00/);
  });

  test('replacing a card does not charge anything, and the invoice stays collected once', async () => {
    const plan = await billingPlan();

    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Stripe Replace ${Date.now()}`);
    await subscribeOrg({ orgId, planId: plan.id, collector: 'stewra_stripe' });
    await backdateSubscription(orgId);

    await openOrgPage(page, '/commerce/billing', orgId, planCard(page));
    await billingLoaded(page);
    await page.getByRole('button', { name: 'Add a card' }).click();
    await fillCard(page);
    await page.getByRole('button', { name: 'Save card' }).click();
    await expect(page.getByText('A card is on file with Stripe.')).toBeVisible();

    await reloadBillingUntil(
      page,
      orgId,
      planCard(page),
      invoiceRows(page).filter({ hasText: 'paid' }).first(),
      'the first invoice collected',
    );

    // Replace the card and let several more sweeps run. The charge job carries an idempotency key
    // per invoice, so a paid invoice must stay one invoice, paid once — a new payment method is not
    // a new reason to collect. This is the assertion that would catch a retry loop billing a
    // customer every sweep, which at an hourly cadence is a story that ends in a chargeback.
    await page.getByRole('button', { name: 'Replace card' }).click();
    await fillCard(page);
    await page.getByRole('button', { name: 'Save card' }).click();
    await expect(page.getByText('Card saved. Invoices are charged automatically from now on.')).toBeVisible();

    await new Promise((resolve) => setTimeout(resolve, 8_000));
    await openOrgPage(page, '/commerce/billing', orgId, planCard(page));
    await billingLoaded(page);
    await expect(invoiceRows(page)).toHaveCount(1);
    await expect(invoiceRows(page).first()).toContainText('paid');
  });
});
