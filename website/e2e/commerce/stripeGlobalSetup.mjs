// Global setup for the Stripe card suite: the commerce stack, plus a hard requirement that it
// actually booted on Stripe.
//
// The check is here rather than in a spec because the alternative is a suite that boots a whole
// backend, drives a page, finds no card button and reports "element not found" — a failure that
// reads like a broken selector and is actually a missing credential. It refuses at setup instead,
// naming the three keys and where they go.
//
// There is deliberately no skip. `playwright.commerce.config.ts` runs at E2E_MAX_SKIPS=0 and holds
// that line by not containing this suite at all; running THIS config is an explicit choice, so
// running it without the keys to do the job is an error rather than a footnote.
import commerceGlobalSetup from './globalSetup.mjs';

export default async function stripeGlobalSetup() {
  const teardown = await commerceGlobalSetup();

  if (process.env['COMMERCE_E2E_BILLING_PROVIDER'] !== 'stripe') {
    await teardown();
    throw new Error(
      '[stripe-e2e] this suite drives real Stripe test mode and backend/.env.test has no Stripe ' +
        'keys, so the stack booted on the `manual` provider — there is no card form to drive.\n' +
        '\n' +
        'Add all three to backend/.env.test, from the TEST-mode keys on the Stripe dashboard:\n' +
        '  STRIPE_SECRET_KEY=sk_test_...\n' +
        '  STRIPE_PUBLISHABLE_KEY=pk_test_...\n' +
        '  STRIPE_WEBHOOK_SECRET=whsec_...\n' +
        '\n' +
        'The rest of billing — plan, collector, invoicing, store suppression — is covered without ' +
        'credentials by `billing.spec.ts` under playwright.commerce.config.ts.',
    );
  }

  return teardown;
}
