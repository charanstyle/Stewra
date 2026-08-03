// Ported from the legacy today.mjs — the proactive Home ("/today") page. Every check
// cross-references the rendered DOM against backend truth (the same /home/briefing +
// /home/suggestions the page consumes), so a pass means "the UI faithfully shows what the
// backend computed", not just "some text appeared".
//
// Precondition: a briefing must already be computed for User A (the scheduler's job in prod;
// seed it once with POST /home/recompute). With no briefing / no open suggestions, the relevant
// checks below use `test.skip(...)` rather than failing — mirroring the original's
// `return 'skip: ...'` early-outs.
//
// That leniency is scoped to "nothing provisioned this run". Once E2E_DATABASE_URL is set, the
// nudge preconditions are the suite's own responsibility (beforeAll provisions them), so the same
// emptiness becomes a failure — see `requireNudges`. Before that split, eight of these tests skipped
// on a run that HAD a database configured, and the suite reported green having checked almost
// nothing about the page.
//
// Deviation from the original: today.mjs ran everything as one continuous script against a
// single page, so steps 6-10 (expand → draft → snooze → dismiss → chat-about-this) shared one
// already-expanded card across steps. Playwright tests are isolated (fresh page per test), so
// each of those steps here independently fetches current backend truth and (re-)expands its
// target nudge — functionally equivalent, but no longer relies on carried DOM state between
// checks. This also means one failing check no longer blocks the others, matching the
// original's per-step try/catch semantics more closely than a single monolithic test would.
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { WEB, apiCall } from '../lib.mjs';
import { config } from '../config.mjs';
import {
  dbEnabled,
  openNeedsReplyNudges,
  restoreNudges,
  seedNeedsReplyNudges,
  cleanupSeededNudges,
  NoSeedableThreadError,
} from '../seed.mjs';

interface SuggestionLike {
  readonly id: string;
  readonly title: string;
}

// How many nudges the action tests need: snooze and dismiss each consume one, expand/draft/chat
// share the rest.
const NUDGES_NEEDED = 4;

// When E2E_DATABASE_URL is set, surface a handful of A's already-triaged needs_reply nudges as
// `open` so the action tests (expand/draft/snooze/dismiss/chat) actually run, then restore their
// exact prior status in afterAll (see seed.mjs). Without it, these tests skip on a quiet inbox.
let nudgeSnapshot: Array<{ id: string; status: string; snoozedUntil: Date | null }> = [];

async function openSuggestions(): Promise<SuggestionLike[]> {
  const res = await apiCall('/home/suggestions');
  return (res.json?.data?.suggestions ?? []) as SuggestionLike[];
}

/**
 * Why provisioning could not happen, or null when it did. Set once in beforeAll, and it is the
 * ONLY reason these tests are allowed to step aside — see `requireNudges`.
 */
let noProvisioningReason: string | null = null;

/**
 * The precondition for every nudge-action test below, stated once.
 *
 * The suite previously skipped identically whether the environment could not provide a nudge or
 * the product failed to produce one, so a run that asserted nothing about Today reported exactly
 * like one that asserted everything. Now there are two distinct outcomes:
 *
 *   • `noProvisioningReason` set → skip, with the specific unmet precondition as the reason, which
 *     the skip reporter prints and counts at the end of the run. Nothing was provisioned, so there
 *     is genuinely nothing to assert against.
 *   • provisioning succeeded but `/home/suggestions` came back empty → FAIL. The nudges exist in
 *     the database; the endpoint or the page is what is broken.
 */
function requireNudges(suggestions: readonly SuggestionLike[], what: string): void {
  if (suggestions.length > 0) {
    return;
  }
  test.skip(noProvisioningReason !== null, `${what} — ${noProvisioningReason}`);
  expect(
    suggestions.length,
    `beforeAll provisioned ${NUDGES_NEEDED} nudge(s) successfully, but GET /home/suggestions ` +
      `returned none (${what})`,
  ).toBeGreaterThan(0);
}

/** Expand the nudge card whose collapsed header contains `title`, returning its header locator. */
function nudgeHeader(page: Page, title: string) {
  return page.getByRole('button', { expanded: false }).filter({ hasText: title }).first();
}

test.describe('today', () => {
  test.beforeAll(async () => {
    if (!dbEnabled) {
      noProvisioningReason =
        'E2E_DATABASE_URL is not set, so no nudge could be provisioned (see seed.mjs)';
      return;
    }
    // Prefer re-opening the user's own already-triaged nudges — those are real rows with real
    // threads, and afterAll puts their exact prior status back. Top up with seeded ones only when
    // there are not enough, which is what A's fully-triaged inbox actually hits.
    nudgeSnapshot = await openNeedsReplyNudges(config.users.a.email, NUDGES_NEEDED);
    const shortfall = NUDGES_NEEDED - nudgeSnapshot.length;
    if (shortfall > 0) {
      try {
        await seedNeedsReplyNudges(config.users.a.email, shortfall);
      } catch (err) {
        // Only this one condition is a precondition rather than a defect: the account has no email
        // data at all, so there is nothing for a nudge to point at. Anything else — a bad
        // connection string, a schema change, a constraint violation — is a broken seed and must
        // propagate and red the suite rather than masquerade as an empty inbox.
        if (!(err instanceof NoSeedableThreadError)) {
          throw err;
        }
        noProvisioningReason = err.message;
      }
    }
  });

  test.afterAll(async () => {
    // Sweep first, restore second: the sweep is by prefix and cannot touch the snapshotted rows, and
    // running it unconditionally means a failure mid-suite still leaves the account clean.
    await cleanupSeededNudges(config.users.a.email);
    await restoreNudges(nudgeSnapshot);
    nudgeSnapshot = [];
  });

  test('Root redirects to /today (post-login landing)', async ({ pageA }) => {
    await pageA.goto(WEB, { waitUntil: 'networkidle' });
    await pageA.waitForURL(/\/today$/, { timeout: 15000 });
    expect(pageA.url()).toMatch(/\/today$/);
  });

  test('Header greeting + subtitle render', async ({ pageA }) => {
    await pageA.goto(`${WEB}/today`, { waitUntil: 'networkidle' });
    const h1 = await pageA.getByRole('heading', { level: 1 }).first().textContent();
    expect(h1 ?? '', `unexpected greeting: "${h1}"`).toMatch(/good (morning|afternoon|evening)/i);
    await expect(pageA.getByText('Here’s what Stewra is watching for you today.')).toBeVisible();
  });

  test('Re-consent banner shows with Reconnect action when a connection needs re-consent', async ({
    pageA,
  }) => {
    const conns = (await apiCall('/connections')).json?.data?.connections ?? [];
    const needs = (conns as ReadonlyArray<{ needsReconsent?: boolean }>).some((c) => c.needsReconsent);
    test.skip(!needs, 'no connection needs re-consent — banner does not apply');

    await pageA.goto(`${WEB}/today`, { waitUntil: 'networkidle' });
    await expect(
      pageA.getByText('Reconnect Google to enable actions on your suggestions.'),
    ).toBeVisible();
    await expect(pageA.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  });

  test('Briefing card matches backend summary + sections', async ({ pageA }) => {
    const briefingRes = await apiCall('/home/briefing');
    const briefing = briefingRes.json?.data?.briefing ?? null;
    test.skip(briefing === null, 'no briefing computed for User A');

    await pageA.goto(`${WEB}/today`, { waitUntil: 'networkidle' });
    const head = (briefing.summary as string).slice(0, 45);
    await expect(pageA.getByText(head, { exact: false }).first()).toBeVisible();
    for (const s of briefing.sections as ReadonlyArray<{ heading: string }>) {
      await expect(pageA.getByRole('heading', { level: 3, name: s.heading })).toBeVisible();
    }
  });

  test('Nudge list matches backend suggestion count', async ({ pageA }) => {
    const suggestions = await openSuggestions();
    await pageA.goto(`${WEB}/today`, { waitUntil: 'networkidle' });
    await expect(pageA.getByText('Needs your attention')).toBeVisible();
    if (suggestions.length === 0) {
      await expect(pageA.getByText('You’re all caught up.')).toBeVisible();
      return;
    }
    // Each nudge title appears verbatim in its card header. Spot-check the first three.
    for (const s of suggestions.slice(0, 3)) {
      await expect(pageA.getByText(s.title, { exact: false }).first()).toBeVisible();
    }
  });

  test('Expand nudge reveals decision prompt', async ({ pageA }) => {
    const suggestions = await openSuggestions();
    requireNudges(suggestions, 'no nudges to expand');
    const title = suggestions[0].title;

    await pageA.goto(`${WEB}/today`, { waitUntil: 'networkidle' });
    await nudgeHeader(pageA, title).click();
    // The option button ("Draft a reply"), add-info label, and the four action buttons should appear.
    await expect(pageA.getByText('Add info').first()).toBeVisible();
    await expect(pageA.getByRole('button', { name: 'Snooze to tomorrow' }).first()).toBeVisible();
    await expect(pageA.getByRole('button', { name: 'Dismiss' }).first()).toBeVisible();
    await expect(
      pageA.getByRole('button', { name: /Chat with Stewra about this/ }).first(),
    ).toBeVisible();
  });

  test('Draft a reply returns draft text', async ({ pageA }) => {
    const suggestions = await openSuggestions();
    requireNudges(suggestions, 'no nudges to draft a reply for');
    const title = suggestions[0].title;

    await pageA.goto(`${WEB}/today`, { waitUntil: 'networkidle' });
    await nudgeHeader(pageA, title).click();
    const draftOption = pageA.getByRole('button', { name: 'Draft a reply' }).first();
    // Every provisioned nudge carries a reply_email option by construction — re-opened ones are
    // selected on `jsonb_array_length(options) > 0`, seeded ones are built with one. Once
    // provisioning has succeeded this is a real failure, not an inapplicable case.
    const hasReplyOption = await draftOption.isVisible().catch(() => false);
    expect(hasReplyOption, 'provisioned nudge is missing its "Draft a reply" option').toBe(true);

    await draftOption.click();
    await pageA.getByText('Draft ready — review it in Chat.').waitFor({ state: 'visible', timeout: 45000 });
    const draftVal = await pageA.getByRole('textbox', { name: 'Drafted reply' }).inputValue();
    expect(draftVal.trim().length, 'draft textarea is empty').toBeGreaterThan(0);
  });

  test('Snooze removes nudge from the list', async ({ pageA }) => {
    const suggestions = await openSuggestions();
    requireNudges(suggestions, 'no nudges to snooze');
    const title = suggestions[0].title;

    await pageA.goto(`${WEB}/today`, { waitUntil: 'networkidle' });
    await nudgeHeader(pageA, title).click();
    const before = await pageA.getByText('Needs a reply').count();
    await pageA.getByRole('button', { name: 'Snooze to tomorrow' }).first().click();
    await pageA.getByText(title, { exact: false }).first().waitFor({ state: 'detached', timeout: 15000 });
    const after = await pageA.getByText('Needs a reply').count();
    expect(after, `expected ${before - 1} cards after snooze, got ${after}`).toBe(before - 1);
  });

  test('Dismiss removes nudge and persists across reload', async ({ pageA }) => {
    const open = await openSuggestions();
    requireNudges(open, 'nothing left to dismiss');
    const target = open[0].title;

    await pageA.goto(`${WEB}/today`, { waitUntil: 'networkidle' });
    await nudgeHeader(pageA, target).click();
    await pageA.getByRole('button', { name: 'Dismiss' }).first().click();
    await pageA.getByText(target, { exact: false }).first().waitFor({ state: 'detached', timeout: 15000 });
    // Reload: the dismissed nudge must not reappear (status persisted server-side).
    await pageA.reload({ waitUntil: 'networkidle' });
    const stillGone = (await pageA.getByText(target, { exact: false }).count()) === 0;
    expect(stillGone, `dismissed nudge "${target}" reappeared after reload`).toBe(true);
  });

  test('Chat-about-this deep-links into /stewra', async ({ pageA }) => {
    const open = await openSuggestions();
    requireNudges(open, 'no nudges to chat about');
    const target = open[0].title;

    await pageA.goto(`${WEB}/today`, { waitUntil: 'networkidle' });
    await nudgeHeader(pageA, target).click();
    await pageA.getByRole('button', { name: /Chat with Stewra about this/ }).first().click();
    await pageA.waitForURL(/\/stewra$/, { timeout: 45000 });
  });

  test('AppNav has Today first + navigation works', async ({ pageA }) => {
    await pageA.goto(`${WEB}/today`, { waitUntil: 'networkidle' });
    const names = await pageA.getByRole('link').allTextContents();
    const navNames = names.map((n) => n.trim()).filter(Boolean);
    expect(navNames[0], `first nav item is "${navNames[0]}", expected "Today"`).toBe('Today');
    await pageA.getByRole('link', { name: 'Activity' }).click();
    await pageA.waitForURL(/\/activity$/, { timeout: 15000 });
    await pageA.getByRole('link', { name: 'Today' }).click();
    await pageA.waitForURL(/\/today$/, { timeout: 15000 });
  });

  test('No console/page errors during a full navigation flow', async ({ pageA }) => {
    const consoleErrors: string[] = [];
    pageA.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
    });
    pageA.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 200)}`));

    await pageA.goto(WEB, { waitUntil: 'networkidle' });
    await pageA.waitForURL(/\/today$/, { timeout: 15000 });
    await pageA.getByRole('link', { name: 'Activity' }).click();
    await pageA.waitForURL(/\/activity$/, { timeout: 15000 });
    await pageA.getByRole('link', { name: 'Today' }).click();
    await pageA.waitForURL(/\/today$/, { timeout: 15000 });

    // A benign, known-noisy source: socket reconnect chatter is not an error. Filter nothing for
    // now; report the raw list so regressions are visible (matches the original's intent).
    expect(consoleErrors, `console errors: ${consoleErrors.slice(0, 3).join(' | ')}`).toHaveLength(0);
  });
});
