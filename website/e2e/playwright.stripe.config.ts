import { defineConfig, devices } from '@playwright/test';

// Card entry and collection, against Stripe's real test mode.
//
// A SEPARATE config from `playwright.commerce.config.ts`, for one reason: credentials. Everything
// in the commerce suite provisions itself, which is what lets CI run it at E2E_MAX_SKIPS=0 — a skip
// there is a regression. This suite cannot provision itself. The card number is typed into an
// iframe served by js.stripe.com and confirmed by Stripe's own script against the publishable key,
// so unlike Meta's Graph there is no network boundary at which Stripe can be replaced, and unlike
// the server's calls there is no `STRIPE_API_BASE_URL` that moves the browser somewhere else. Test
// mode with a real `pk_test_`/`sk_test_` pair is not a compromise here; it is the only honest way
// to prove a customer can put a card on file.
//
// So: the keys are a precondition of running this at all, `commerce/stripeGlobalSetup.mjs` refuses
// without them, and nothing anywhere reports a skip. Run it with:
//   npm run test:e2e:stripe
//
// `testMatch` picks up `*.stripe.ts` rather than `*.spec.ts` so these files are invisible to the
// commerce config sharing the same directory — one stack, one set of helpers, two audiences.
export default defineConfig({
  testDir: './commerce',
  testMatch: /.*\.stripe\.ts/,
  globalSetup: './commerce/stripeGlobalSetup.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Longer than the commerce suite's 120s: this one waits on Stripe's own network round trips for
  // the SDK, the setup confirmation and the charge, on top of the local billing sweep.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: '.artifacts/stripe-report', open: 'never' }],
    ['./skip-reporter.mjs'],
  ],
  outputDir: '.artifacts/stripe-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 860 } },
    },
  ],
});
