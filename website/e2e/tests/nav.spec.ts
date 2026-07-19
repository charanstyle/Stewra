// Ported from the legacy full.mjs section "1. ENTRY / AUTH / NAV" (nav-tagged checks).
// See auth.spec.ts for the auth-tagged checks from the same section.
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { WEB } from '../lib.mjs';

/** Current URL path only (mirrors the old runner's `path()` helper). */
function pathOf(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return page.url();
  }
}

const nonce = (): string => Math.random().toString(36).slice(2, 8);

test.describe('nav', () => {
  test('home page (/) navigation reachability', async ({ pageA }) => {
    await pageA.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(2000);
    const landed = pathOf(pageA);
    console.log(`[nav] root "/" landing (authenticated): landed ${landed}`);

    const chatsLink = await pageA.getByRole('link', { name: 'Chats' }).isVisible().catch(() => false);
    const talkLink = await pageA
      .getByRole('link', { name: 'Talk to Stewra' })
      .isVisible()
      .catch(() => false);
    const contactsLink = await pageA
      .getByRole('link', { name: 'Contacts' })
      .isVisible()
      .catch(() => false);

    // Home must link to messaging somehow (Chats / Talk to Stewra / Contacts) — a real hard
    // requirement in the original (fail if none present, not just informational).
    expect(
      chatsLink || talkLink || contactsLink,
      `messaging must be reachable by navigation from home (landed ${landed}); ` +
        `chats=${chatsLink} talk=${talkLink} contacts=${contactsLink}`,
    ).toBe(true);

    // custom header affordances that DO exist on home — diagnostic only.
    const learned = await pageA
      .getByRole('link', { name: /What I.?ve learned/i })
      .isVisible()
      .catch(() => false);
    const signout = await pageA.getByRole('button', { name: 'Sign out' }).isVisible().catch(() => false);
    console.log(`[nav] home custom header buttons: "What I've learned"=${learned}, "Sign out"=${signout}`);
  });

  test('AppNav links navigate correctly (click-through)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('link', { name: 'Chats' }).first().waitFor({ timeout: 15000 });
    await pageA.getByRole('link', { name: 'Talk to Stewra' }).click();
    await pageA.waitForURL('**/stewra', { timeout: 10000 });
    await pageA.getByRole('link', { name: 'Contacts' }).click();
    await pageA.waitForURL('**/contacts', { timeout: 10000 });
    await pageA.getByRole('link', { name: 'Chats' }).click();
    await pageA.waitForURL('**/chats', { timeout: 10000 });
  });

  test('Activity ↔ Memory navigation', async ({ pageA }) => {
    await pageA.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('link', { name: /What I.?ve learned/i }).click();
    await pageA.waitForURL('**/memory', { timeout: 10000 });
    // AppNav has no "Back" button; return via the nav link.
    await pageA.getByRole('link', { name: 'Activity' }).click();
    await pageA.waitForURL('**/activity', { timeout: 10000 });
  });

  test('unknown route redirects to /today', async ({ pageA }) => {
    await pageA.goto(`${WEB}/zzz-${nonce()}`, { waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(1500);
    expect(pathOf(pageA)).toBe('/today');
  });
});
