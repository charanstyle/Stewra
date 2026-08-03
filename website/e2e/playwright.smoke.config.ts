import { defineConfig, devices } from '@playwright/test';
import { env, required } from './env.mjs';

// The deploy gate: ~30 seconds, one browser, and NO credentials — deliberately separate from
// `playwright.config.ts`, which imports `config.mjs` and therefore throws without the two QA
// accounts. Anyone (and CI, which has neither) can run this one.
//
// The target is E2E_SMOKE_TARGET, not E2E_WEB_URL, and that distinction is load-bearing: the
// repo-root `.env.e2e` sets E2E_WEB_URL to production, so reusing it would mean `npm run
// test:smoke:preview` silently gated the deploy on production instead of on the build about to be
// deployed — passing while shipping the broken bundle. A separate required name cannot do that.
const target = required(env.E2E_SMOKE_TARGET, 'E2E_SMOKE_TARGET').replace(/\/$/, '');

export default defineConfig({
  testDir: './smoke',
  // These are `*.smoke.ts`, not `*.spec.ts` — the default testMatch would find none of them, and
  // Playwright reports that as "No tests found", which reads like a passing gate to a CI eye.
  testMatch: '**/*.smoke.ts',
  fullyParallel: true,
  // No retries: a gate that passes on the second attempt is telling you something, and hiding it
  // behind a retry is how a flaky deploy becomes a green deploy.
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: '.artifacts/smoke.json' }],
  ],
  outputDir: '.artifacts/smoke-results',
  use: {
    baseURL: target,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
