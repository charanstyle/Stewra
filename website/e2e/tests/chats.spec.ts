// Ported from the legacy full.mjs section "2. CHATS LIST (presence + unread)".
import { test, expect } from '../fixtures';
import { WEB, uiHasTestids } from '../lib.mjs';

const nonce = (): string => Math.random().toString(36).slice(2, 8);

test.describe('chats', () => {
  test('conversation list renders', async ({ pageA, convId }) => {
    void convId; // ensures the A↔B direct conversation exists so the list is non-empty
    await pageA.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: 'Chats' }).waitFor({ timeout: 12000 });
    const rows = pageA.locator('li');
    const n = await rows.count();
    console.log(`[chats] conversation list renders ${n} row(s)`);
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

    // presence: A's row for B should show an online dot now that B is connected. Timing-sensitive
    // in the original (marked info, not a hard fail) — kept as a diagnostic here too.
    const dot = await pageA.getByTestId('presence-dot').first().isVisible().catch(() => false);
    console.log(`[chats] online presence dot for a connected peer visible=${dot}`);

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
