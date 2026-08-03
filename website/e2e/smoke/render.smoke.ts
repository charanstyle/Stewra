// Post-deploy smoke: does the BUILT app actually render for a logged-out visitor?
//
// Written after `vite build` shipped two React module instances into one bundle (the website tracks
// react 19.2.8, the workspace root hoists the 19.2.0 that Expo pins for `frontend`, and any dep whose
// resolution walked up to the root — react-hook-form — got the other React). react-dom installed its
// dispatcher on one copy; every hook called through the other read `null`. LoginPage threw on
// `useForm()`, React unmounted the tree, and www.stewra.com served a blank page to every logged-out
// visitor. Nothing caught it: `vite dev` pre-bundles to one copy so local dev was fine, CI never
// built the website, and the whole Playwright suite runs from a seeded `storageState` — only one
// spec ever rendered the login page at all.
//
// So this file deliberately holds itself to two rules:
//
//   1. It imports `test` from @playwright/test, NEVER from `../fixtures` — the fixtures log two QA
//      accounts in on setup, and a gate that needs credentials is a gate nobody runs.
//   2. It asserts on `pageerror`, not only on visible elements. The outage was a thrown exception.
//      "The heading is missing" tells you something broke; the exception tells you what.
//
// Runs unchanged against `vite preview` of a fresh build (in CI, before anything ships) and against
// the deployed site (after it ships). Target comes from E2E_SMOKE_TARGET — see playwright.smoke.config.ts.
import { test, expect, type Page } from '@playwright/test';

// Collect every uncaught exception and failed console error from before the first navigation.
// Returned as a live array: assert it is empty AFTER the interactions, so a hook that throws on a
// later render (the register-mode toggle) is caught too.
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  return errors;
}

// Assert cleanliness BEFORE the element assertions, not only after. Ordering is the whole point: if
// the bundle throws during mount, every element assertion fails too, and whichever runs first is the
// message a person reads at 2am. "expected heading to be visible" sends them hunting for a markup
// change; "TypeError: Cannot read properties of null (reading 'useRef')" names the actual fault.
function assertClean(errors: string[], when: string): void {
  expect(errors, `the page reported errors ${when}:\n  ${errors.join('\n  ')}`).toEqual([]);
}

// `load` (not `domcontentloaded`) is load-bearing here: the entry is a module script, so only `load`
// guarantees it has executed and React has mounted. With `domcontentloaded` the error listener could
// be asserted empty before the bundle had a chance to throw.
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'load' });
}

test.describe('smoke: the built app renders', () => {
  test('login page renders, and toggling to register mounts the Name field', async ({ page }) => {
    const errors = watchForErrors(page);

    await open(page, '/login');
    assertClean(errors, 'while rendering /login');

    // The static shell. If React never mounted, #root is empty and all of these are missing.
    await expect(page.getByRole('heading', { name: 'Stewra' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' }).first()).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();

    // The register toggle is the load-bearing half. `useForm()` runs on the first render either way,
    // but re-registering a newly mounted field exercises the hook path that actually threw. A purely
    // static render assertion would not have caught the bug this file exists for.
    await page.getByRole('button', { name: 'Create account' }).first().click();
    await expect(page.locator('input[autocomplete="name"]')).toBeVisible();

    // Typing proves the controlled-input wiring survived, not just that the node exists.
    await page.locator('input[autocomplete="name"]').fill('Smoke Test');
    await expect(page.locator('input[autocomplete="name"]')).toHaveValue('Smoke Test');

    assertClean(errors, 'by the end of the test');
  });

  test('unauthenticated deep link redirects to /login', async ({ page }) => {
    const errors = watchForErrors(page);

    await open(page, '/chats');
    assertClean(errors, 'while rendering the /chats redirect');
    await expect(page).toHaveURL(/\/login$/);
    // Checked again after the redirect resolves, not just after `load`: this route mounts LoginPage
    // only once the router has redirected, so a mount-time throw lands here rather than above.
    assertClean(errors, 'while rendering /login after the redirect');
    // The redirect alone is not the check — the router redirected correctly during the outage too,
    // and then rendered nothing. The form has to be there.
    await expect(page.getByRole('heading', { name: 'Stewra' }).first()).toBeVisible();

    assertClean(errors, 'by the end of the test');
  });

  test('the public /runner download page renders', async ({ page }) => {
    const errors = watchForErrors(page);

    await open(page, '/runner');
    assertClean(errors, 'while rendering /runner');
    await expect(
      page.getByRole('heading', { name: 'Run coding agents on your own machine' }),
    ).toBeVisible();

    assertClean(errors, 'by the end of the test');
  });

  test('every asset index.html references is actually served', async ({ page, baseURL }) => {
    // Catches a half-deployed image: index.html rebuilt with new hashed chunk names while the old
    // assets are still on disk (or vice versa). The browser would show a blank page with a 404 in
    // the network log and no exception at all, so the pageerror listener above cannot see it.
    const res = await page.request.get(`${baseURL}/index.html`);
    expect(res.status(), 'GET /index.html').toBe(200);
    const html = await res.text();

    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    expect(refs.length, `index.html references no /assets/* files:\n${html}`).toBeGreaterThan(0);

    for (const ref of refs) {
      const asset = await page.request.get(`${baseURL}${ref}`);
      expect(asset.status(), `GET ${ref}`).toBe(200);
    }
  });
});
