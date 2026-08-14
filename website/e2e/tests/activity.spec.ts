// Ported from the legacy full.mjs section "7. ACTIVITY (home) features".
import { test, expect } from '../fixtures';
import { WEB } from '../lib.mjs';

test.describe('activity', () => {
  test('home cards render', async ({ pageA }) => {
    await pageA.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    // "Stewra" is only the nav brand, not a card heading — wait for a real, always-present card.
    await pageA.getByRole('heading', { name: 'Your sources' }).first().waitFor({ timeout: 12000 });
    // These five cards are unconditionally rendered for every account, so assert them rather than
    // logging a boolean the runner ignores — a missing card used to pass as `visible=false`.
    for (const h of ['Your sources', 'Gmail window', 'Learn my writing style', 'Ask for an insight', 'Activity']) {
      await expect(pageA.getByRole('heading', { name: h }), `card "${h}" missing`).toBeVisible();
    }
  });

  test('Connect Google → in-page consent modal → Not now', async ({ pageA }) => {
    await pageA.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const connectBtn = pageA.getByRole('button', { name: 'Connect a Google account' });
    await connectBtn.waitFor({ timeout: 12000 });
    // `emailVerified` is `user?.emailVerified ?? false`, so the button renders DISABLED until
    // useAuth() resolves. Sampling isDisabled() the instant it appears therefore skipped this
    // test on every run against a perfectly verified account. Wait for enabled instead, and
    // only treat a button that is still disabled after the wait as a genuine precondition.
    const enabled = await connectBtn
      .isEnabled({ timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!enabled, 'Connect button still disabled after load (email not verified)');

    await connectBtn.click();
    // The "One quick check" modal only appears after an async startGoogleConnection() round-trip,
    // so wait for it rather than checking instantly (the instant check races the network call).
    const modal = await pageA
      .getByText('One quick check', { exact: false })
      .waitFor({ timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    expect(modal, `modal shown=${modal}`).toBe(true);

    // Do NOT click "Yes, continue to Google" (real external OAuth redirect) — original reasoning:
    // "would redirect off-app to real Google consent — cancelled with 'Not now'". Cancel instead.
    await pageA.getByRole('button', { name: 'Not now' }).click().catch(() => {});
  });

  test('Gmail window Save (re-save current value, non-destructive)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const card = pageA.locator('div').filter({ hasText: 'Gmail window' }).last();
    const saveBtn = card.getByRole('button', { name: 'Save' });
    // Wait for the button rather than sampling it. After `domcontentloaded` React has not mounted, so
    // the old instantaneous `isVisible()` raced the render and logged "Save button not found" on every
    // run — a false negative, since ActivityPage renders this button unconditionally. The `if/else`
    // around it meant the test passed either way, so nothing ever surfaced the gap.
    await saveBtn.waitFor({ timeout: 12000 });

    // "Currently N days." only renders once preferences have loaded, and it is the server's value —
    // which makes it the thing worth asserting: re-saving must round-trip and come back unchanged.
    const current = card.getByText(/^Currently \d+ days\.$/);
    await current.waitFor({ timeout: 12000 });
    const before = await current.textContent();

    await saveBtn.click();

    // The value must survive the round-trip, and no error banner may appear. `toHaveText` retries, so
    // this waits for the PATCH rather than guessing at a sleep.
    await expect(current).toHaveText(String(before));
    await expect(pageA.getByText('Choose a whole number of days', { exact: false })).toHaveCount(0);
    console.log(`[activity] Gmail window Save re-saved existing value unchanged (${before})`);
  });

  test('Learn-my-writing-style toggle (flip + restore)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const cb = pageA
      .locator('div')
      .filter({ hasText: 'Learn my writing style' })
      .last()
      .locator('input[type="checkbox"]');
    // Same race as the Save button above: the old instant `isVisible()` ran before React mounted and
    // logged "checkbox not found" every time, inside an `if/else` that passed regardless. The input is
    // also `disabled` until preferences load, so wait for enabled — clicking it earlier does nothing.
    await expect(cb).toBeEnabled({ timeout: 12000 });

    const orig = await cb.isChecked();
    await cb.click({ force: true });
    // `toBeChecked` retries, so it waits out the PATCH instead of a fixed sleep that could pass on a
    // toggle the server rejected.
    await expect(cb).toBeChecked({ checked: !orig });
    await cb.click({ force: true }); // RESTORE — this is a real preference on a real account
    await expect(cb).toBeChecked({ checked: orig });
    console.log(`[activity] writing-style toggle flipped to ${!orig} and restored to ${orig}`);
  });

  test('generate an insight + submit feedback', async ({ pageA }) => {
    await pageA.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const calBtn = pageA.getByRole('button', { name: 'Look at my calendar' });
    await calBtn.waitFor({ timeout: 12000 });
    // Same load race as the Connect button above — see the comment there.
    const enabled = await calBtn
      .isEnabled({ timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!enabled, 'insight buttons still disabled after load (email not verified)');

    await calBtn.click();
    // insight card renders 💡 …; may take a while (reads real calendar via LLM).
    await pageA.getByText('💡', { exact: false }).waitFor({ timeout: 90000 });

    // FeedbackControl appears — submit a rating.
    // ActivityPage renders `{insightId !== null && <FeedbackControl .../>}` and the insight card
    // above has already been waited for, so the control is guaranteed here. The previous
    // `isVisible()` GUARD had the very trap its own inner comment describes: instantaneous, so a
    // control that had not painted yet took the else branch and the whole feedback learning loop
    // went untested while the run stayed green. The guard is now an assertion like the body.
    const fb = pageA.getByRole('group', { name: 'Rate this insight' });
    await expect(fb).toBeVisible();
    await fb.getByRole('button').first().click();
    await pageA.getByRole('button', { name: 'Send feedback' }).click();
    // FeedbackControl only swaps in the "✓ Thanks …" panel after `await api.submitFeedback(...)`
    // resolves, so an instantaneous check would sample before the POST could possibly have
    // returned. `toBeVisible` retries, which is what makes this a real check on the loop.
    await expect(pageA.getByText('Thanks', { exact: false })).toBeVisible();
  });
});
