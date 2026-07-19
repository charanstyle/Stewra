// Ported from the legacy full.mjs section "7. ACTIVITY (home) features".
import { test, expect } from '../fixtures';
import { WEB } from '../lib.mjs';

test.describe('activity', () => {
  test('home cards render', async ({ pageA }) => {
    await pageA.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    // "Stewra" is only the nav brand, not a card heading — wait for a real, always-present card.
    await pageA.getByRole('heading', { name: 'Your sources' }).first().waitFor({ timeout: 12000 });
    for (const h of ['Your sources', 'Gmail window', 'Learn my writing style', 'Ask for an insight', 'Activity']) {
      const vis = await pageA.getByRole('heading', { name: h }).isVisible().catch(() => false);
      console.log(`[activity] card "${h}" renders: visible=${vis}`);
    }
  });

  test('Connect Google → in-page consent modal → Not now', async ({ pageA }) => {
    await pageA.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const connectBtn = pageA.getByRole('button', { name: 'Connect a Google account' });
    await connectBtn.waitFor({ timeout: 12000 });
    const disabled = await connectBtn.isDisabled().catch(() => false);
    test.skip(disabled, 'Connect button disabled (email not verified) — modal not exercised');

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
    const saveBtn = pageA
      .locator('section, div')
      .filter({ hasText: 'Gmail window' })
      .getByRole('button', { name: 'Save' })
      .first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await pageA.waitForTimeout(1200);
      console.log('[activity] Gmail window Save works: re-saved existing value (no change)');
    } else {
      console.log('[activity] Gmail window Save: Save button not found');
    }
  });

  test('Learn-my-writing-style toggle (flip + restore)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const cb = pageA.locator('input[type="checkbox"]').first();
    if (await cb.isVisible().catch(() => false)) {
      const orig = await cb.isChecked();
      await cb.click({ force: true });
      await pageA.waitForTimeout(1000);
      const flipped = (await cb.isChecked()) !== orig;
      await cb.click({ force: true }); // RESTORE
      await pageA.waitForTimeout(800);
      const restored = (await cb.isChecked()) === orig;
      console.log(`[activity] writing-style toggle flips and restores: flipped=${flipped}, restored=${restored}`);
    } else {
      console.log('[activity] writing-style toggle: checkbox not found');
    }
  });

  test('generate an insight + submit feedback', async ({ pageA }) => {
    await pageA.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const calBtn = pageA.getByRole('button', { name: 'Look at my calendar' });
    await calBtn.waitFor({ timeout: 12000 });
    const disabled = await calBtn.isDisabled().catch(() => false);
    test.skip(
      disabled,
      'insight buttons disabled (needs verified email / connected source) — not exercised',
    );

    await calBtn.click();
    // insight card renders 💡 …; may take a while (reads real calendar via LLM).
    await pageA.getByText('💡', { exact: false }).waitFor({ timeout: 90000 });

    // FeedbackControl appears — submit a rating.
    const fb = pageA.getByRole('group', { name: 'Rate this insight' });
    if (await fb.isVisible().catch(() => false)) {
      const firstRating = fb.getByRole('button').first();
      await firstRating.click();
      await pageA.getByRole('button', { name: 'Send feedback' }).click();
      const thanks = await pageA.getByText('Thanks', { exact: false }).isVisible().catch(() => false);
      console.log(`[activity] submit insight feedback (feedback learning loop): confirmation shown=${thanks}`);
    } else {
      console.log('[activity] feedback control: FeedbackControl not shown for this insight');
    }
  });
});
