// Playwright global setup for the commerce suite: brings the local stack up before any spec runs,
// and returns the teardown Playwright calls when the run ends.
//
// The stack's addresses are published through `process.env` because Playwright forks its workers
// after this function resolves, so they inherit whatever it sets. A spec that read a hardcoded port
// instead would pass against whatever else happened to be listening.
import { startCommerceStack } from './stack.mjs';

export default async function globalSetup() {
  const stack = await startCommerceStack();

  process.env['COMMERCE_E2E_WEB_URL'] = stack.webUrl;
  process.env['COMMERCE_E2E_API_URL'] = stack.apiUrl;
  process.env['COMMERCE_E2E_GRAPH_URL'] = stack.graphOrigin;
  process.env['COMMERCE_E2E_APP_SECRET'] = stack.appSecret;
  process.env['COMMERCE_E2E_EMAIL'] = stack.user.email;
  process.env['COMMERCE_E2E_PASSWORD'] = stack.user.password;
  process.env['COMMERCE_E2E_BILLING_PROVIDER'] = stack.billingProvider;
  process.env['COMMERCE_E2E_DATABASE_URL'] = stack.databaseUrl;

  process.stdout.write(
    `\n[commerce-e2e] website ${stack.webUrl} · api ${stack.apiUrl} · graph stub ${stack.graphOrigin}\n` +
      `[commerce-e2e] QA user ${stack.user.email}\n` +
      `[commerce-e2e] billing provider: ${stack.billingProvider}` +
      (stack.billingProvider === 'manual'
        ? ' — card entry is NOT covered by this run. Put Stripe TEST keys in backend/.env.test' +
          ' (STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET) to cover it.\n\n'
        : '\n\n'),
  );

  return async () => {
    await stack.stop();
  };
}
