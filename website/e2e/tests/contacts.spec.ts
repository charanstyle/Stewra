// Ported from the legacy full.mjs section "6. CONTACTS".
//
// Every check here asserts. The ported originals mostly did not: they computed a boolean with
// `isVisible()`, `console.log`ed it, and returned. `isVisible()` resolves INSTANTLY against the
// current DOM — it never waits — so on a page whose contact list arrives in a later fetch it
// answers `false` and the test passes having proved nothing. That is how the invite-by-email 404
// survived: the site had never been able to send an invite from the browser, and the suite was
// green. Assertions here use `expect(locator)`, which retries until the timeout.
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { B, WEB } from '../lib.mjs';

/** Current URL path only (mirrors the old runner's `path()` helper). */
function pathOf(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return page.url();
  }
}

/**
 * The `<section>` card carrying `title`. Scoping matters: "Find people" and "Your contacts" both
 * render a `Message` button, so an unscoped `getByRole('button', { name: 'Message' })` is ambiguous
 * about which surface it is exercising. Located via the heading rather than a class, because CSS
 * Modules hashes class names at build time.
 */
function card(page: Page, title: string) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });
}

/** The "Your contacts" row for User B — the contact the worker fixture guarantees exists. */
function contactRowB(page: Page) {
  return card(page, 'Your contacts').locator('li').filter({ hasText: B.email });
}

test.describe('contacts', () => {
  test('search people + Message action', async ({ pageA }) => {
    await pageA.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    const find = card(pageA, 'Find people');
    await find.getByPlaceholder('Search by name or email').fill(B.email.split('@')[0]);
    await find.getByRole('button', { name: 'Search' }).click();

    const result = find.locator('li').filter({ hasText: B.email });
    await expect(result, 'people search must return the peer account').toBeVisible();

    // The test is named for this action, so it performs it: the search result's Message button
    // opens (or creates) the direct conversation and routes to it.
    await result.getByRole('button', { name: 'Message' }).click();
    await pageA.waitForURL('**/chats/**', { timeout: 15000 });
    expect(pathOf(pageA), 'Message from a search result must open the conversation').toMatch(
      /^\/chats\//,
    );
  });

  test('contacts list renders + invite form present', async ({ pageA }) => {
    await pageA.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await expect(pageA.getByRole('heading', { name: 'Your contacts' })).toBeVisible();
    await expect(pageA.getByPlaceholder('name@example.com')).toBeVisible();
    await expect(pageA.getByRole('button', { name: 'Send invite' })).toBeVisible();
    // The worker fixture pairs A and B, so an empty list is a failure, not a valid state.
    await expect(contactRowB(pageA), 'User B must appear in User A contacts').toBeVisible();
  });

  test('invite by email (graceful for existing contact)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await pageA.getByPlaceholder('name@example.com').fill(B.email);
    await pageA.getByRole('button', { name: 'Send invite' }).click();
    await pageA.waitForTimeout(2000);
    // Either a success notice or a domain-level refusal (already contacts) is fine. What is
    // NOT fine is the request never reaching the handler: the old version of this check only
    // logged a regex that also matched the word "error", so a 404 from the website posting to
    // the wrong path (`/contacts/invite` vs the backend's `/contacts/invites`) passed silently.
    const notice = await pageA.locator('main').innerText();
    expect(notice, 'invite POST must reach the contacts handler, not 404').not.toMatch(
      /Route not found|Not Found/i,
    );
    expect(notice, 'invite must produce a success notice or a domain-level refusal').toMatch(
      /Invite sent|already|contact/i,
    );
  });

  test('Block then Unblock a contact (state restored)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    const row = contactRowB(pageA);
    await expect(row).toBeVisible();

    // `exact` is load-bearing: accessible-name matching is substring-based and case-insensitive,
    // so a non-exact 'Block' ALSO matches the 'Unblock' button and the two states are
    // indistinguishable. The original test had exactly that bug.
    const block = row.getByRole('button', { name: 'Block', exact: true });
    const unblock = row.getByRole('button', { name: 'Unblock', exact: true });

    // Recovery: an earlier aborted run may have left B blocked. Clearing it first both proves the
    // toggle and returns the shared production account to its clean state.
    if ((await unblock.count()) > 0) {
      await unblock.click();
      await expect(block).toBeVisible();
    }

    await block.click();
    await expect(unblock, 'Block must flip the row to Unblock').toBeVisible();
    await unblock.click(); // RESTORE
    await expect(block, 'Unblock must restore the original state').toBeVisible();
  });

  test('Message from contact row opens a conversation', async ({ pageA }) => {
    await pageA.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    const row = contactRowB(pageA);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Message' }).click();
    await pageA.waitForURL('**/chats/**', { timeout: 15000 });
    expect(pathOf(pageA), 'Message from a contact row must open the conversation').toMatch(
      /^\/chats\//,
    );
  });
});
