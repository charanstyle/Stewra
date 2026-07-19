// Playwright fixtures for the Stewra website E2E suite.
//
// Two authenticated sessions (A and B) are needed because the site keeps auth in
// per-origin localStorage, so two users cannot share one browser context. We log both
// in via the API ONCE per worker (no pasted tokens, no per-test login that would trip
// the per-IP login rate limiter), seed each context's localStorage via storageState,
// and ensure the A↔B direct conversation exists up front.
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  A,
  B,
  WEB,
  loginAll,
  ensureConversation,
  storageStateFor,
} from './lib.mjs';

type WorkerFixtures = {
  // Logs both QA users in once per worker and guarantees their direct conversation exists.
  session: { convId: string };
};

type TestFixtures = {
  ctxA: BrowserContext;
  pageA: Page;
  ctxB: BrowserContext;
  pageB: Page;
  // The A↔B direct conversation id (created if missing).
  convId: string;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  session: [
    async ({}, use) => {
      await loginAll(); // mutates A/B with fresh tokens for this worker
      const convId = await ensureConversation(A, B);
      await use({ convId });
    },
    { scope: 'worker' },
  ],

  convId: async ({ session }, use) => {
    await use(session.convId);
  },

  ctxA: async ({ browser, session }, use, testInfo) => {
    void session; // ensures login ran before we read A's tokens into storageState
    const viewport = testInfo.project.use.viewport ?? { width: 1180, height: 860 };
    const ctx = await browser.newContext({ viewport, storageState: storageStateFor(A) });
    await ctx.grantPermissions(['microphone', 'camera'], { origin: WEB });
    await use(ctx);
    await ctx.close();
  },
  pageA: async ({ ctxA }, use) => {
    const page = await ctxA.newPage();
    page.on('pageerror', (e) => console.log(`  [A pageerror] ${e.message}`));
    await use(page);
  },

  ctxB: async ({ browser, session }, use, testInfo) => {
    void session;
    const viewport = testInfo.project.use.viewport ?? { width: 1180, height: 860 };
    const ctx = await browser.newContext({ viewport, storageState: storageStateFor(B) });
    await ctx.grantPermissions(['microphone', 'camera'], { origin: WEB });
    await use(ctx);
    await ctx.close();
  },
  pageB: async ({ ctxB }, use) => {
    const page = await ctxB.newPage();
    page.on('pageerror', (e) => console.log(`  [B pageerror] ${e.message}`));
    await use(page);
  },
});

export { expect };
