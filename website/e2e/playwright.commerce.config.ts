import { defineConfig, devices } from '@playwright/test';

// The commerce suite is the one suite in this package that does NOT drive production.
//
// It cannot: the commerce plane is not deployed, and connecting a channel means completing Meta's
// Embedded Signup against a real WhatsApp Business Account owned by a real business — which no test
// may do to a live account. `commerce/globalSetup.mjs` therefore boots a real backend and a real
// website against the test database, with Meta replaced at the network boundary by a stand-in Graph
// server, and publishes the addresses through the environment.
//
// No `baseURL` here on purpose: the ports are chosen at boot, after this file is evaluated, so the
// specs read `COMMERCE_E2E_WEB_URL` instead of a value that would be stale by the time it is used.
export default defineConfig({
  testDir: './commerce',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './commerce/globalSetup.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: '.artifacts/commerce-report', open: 'never' }],
    // Same skip gate as the main suite: a skipped test must announce itself rather than blend into
    // the passed column.
    ['./skip-reporter.mjs'],
  ],
  outputDir: '.artifacts/commerce-results',
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
