// Ported from the legacy full.mjs section "2. CHATS LIST (presence + unread)".
import { test, expect } from '../fixtures';
import { WEB, uiHasTestids } from '../lib.mjs';

const nonce = (): string => Math.random().toString(36).slice(2, 8);

test.describe('chats', () => {
  test('conversation list renders', async ({ pageA, convId }) => {
    void convId; // ensures the A↔B direct conversation exists so the list is non-empty
    await pageA.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: 'Chats' }).waitFor({ timeout: 12000 });
    // The heading renders before the list finishes loading, so counting rows immediately raced it
    // and reported 0 — which this test then logged and passed anyway. Wait for the first row (the
    // A↔B conversation the `convId` fixture guarantees) before asserting the list is non-empty.
    const rows = pageA.locator('li');
    await rows.first().waitFor({ timeout: 12000 });
    const n = await rows.count();
    expect(n, `conversation list rendered ${n} row(s), expected at least 1`).toBeGreaterThan(0);
  });

  test('New chat button routes to Contacts', async ({ pageA }) => {
    await pageA.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('button', { name: 'New chat' }).click();
    await pageA.waitForURL('**/contacts', { timeout: 10000 });
  });

  test('presence dot + unread badge', async ({ pageA, pageB, convId }) => {
    // B online, in the thread, sends a message while A sits on the list.
    await pageA.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: 'Chats' }).waitFor({ timeout: 12000 });
    test.skip(
      !(await uiHasTestids(pageA)),
      'requires the website data-testid contract (app-nav sentinel absent) — deploy website first',
    );
    await pageB.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pageB.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    await pageA.waitForTimeout(1500);

    // Presence: A's row for B must show an online dot now that B is connected. The original marked
    // this info-only because it was timing-sensitive — but the fix for timing-sensitive is a
    // retrying assertion, not a report nobody reads. `expect(locator)` polls until the timeout, so
    // a dot that arrives on the next presence broadcast passes and a dot that never arrives fails.
    await expect(pageA.getByTestId('presence-dot').first()).toBeVisible({ timeout: 15000 });

    // unread: B sends; A's list should surface an unread badge + preview live — this IS a hard
    // requirement in the original (either the badge or a live preview must appear).
    const msg = `unread-probe ${nonce()}`;
    await pageB.getByPlaceholder('Type a message').fill(msg);
    await pageB.getByRole('button', { name: 'Send' }).click();
    let badge = false;
    try {
      await pageA.getByTestId('unread-badge').first().waitFor({ timeout: 8000 });
      badge = true;
    } catch {
      // maybe list shows preview only
    }
    const preview = await pageA.getByText(msg, { exact: false }).first().isVisible().catch(() => false);
    expect(badge || preview, `unreadBadge=${badge}, previewShown=${preview}`).toBe(true);
  });
});
