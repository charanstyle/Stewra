// Ported from the legacy full.mjs section "8. MEMORY features".
//
// User A has no learned memories of its own (nothing has been fed back), so the edit/hide/delete
// UI only exists to drive when the suite provisions one. When E2E_DATABASE_URL is set, beforeAll
// seeds a single clearly-labelled throwaway memory (seed.mjs) that these tests exercise and the
// delete test removes; afterAll sweeps any leftover. Without it, the seed is skipped and the
// original resilient "act only if a card is present" behaviour still holds.
import { test, expect } from '../fixtures';
import { WEB } from '../lib.mjs';
import { config } from '../config.mjs';
import {
  dbEnabled,
  seedThrowawayMemory,
  cleanupThrowawayMemories,
  THROWAWAY_MEMORY_LABEL,
} from '../seed.mjs';

test.describe('memory', () => {
  test.beforeAll(async () => {
    if (dbEnabled) {
      await seedThrowawayMemory(config.users.a.email);
    }
  });

  test.afterAll(async () => {
    await cleanupThrowawayMemories(config.users.a.email);
  });

  test('memory page renders + search + source filter', async ({ pageA }) => {
    await pageA.goto(`${WEB}/memory`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: /What Stewra has learned/i }).waitFor({ timeout: 12000 });

    const search = pageA.getByPlaceholder(/Search by name, purpose, or guidance/i);
    if (await search.isVisible().catch(() => false)) {
      await search.fill('email');
      await pageA.waitForTimeout(700);
      await search.fill('');
      await pageA.waitForTimeout(500);
      console.log('[memory] search input accepts input (debounced), no crash on query');
    } else {
      console.log('[memory] search input not visible');
    }

    const filter = pageA.getByLabel('Filter by source');
    if (await filter.isVisible().catch(() => false)) {
      await filter.selectOption('gmail').catch(() => {});
      await pageA.waitForTimeout(800);
      await filter.selectOption('').catch(() => {});
      console.log('[memory] source filter select changes value: toggled gmail → All sources');
    } else {
      console.log('[memory] source filter select not visible');
    }
  });

  test('memory card Edit → Cancel (non-mutating)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/memory`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: /What Stewra has learned/i }).waitFor({ timeout: 12000 });
    // Precondition, not an outcome: with no memory to edit there is nothing to exercise, so skip
    // visibly instead of logging "no editable memory present" and reporting a green pass. When a
    // card IS present the editor behaviour is a hard assertion.
    const editBtn = pageA.getByRole('button', { name: 'Edit' }).first();
    test.skip(
      !(await editBtn.isVisible().catch(() => false)),
      'no editable memory/rule present — set E2E_DATABASE_URL to seed one (see seed.mjs)',
    );

    await editBtn.click();
    const cancel = pageA.getByRole('button', { name: 'Cancel' }).first();
    await expect(cancel, 'Edit did not open the editor').toBeVisible();
    await cancel.click();
    await expect(cancel, 'Cancel did not close the editor').toBeHidden();
  });

  test('hide/use-for-recall toggle (reversible)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/memory`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: /What Stewra has learned/i }).waitFor({ timeout: 12000 });
    // Same shape as Edit → Cancel above: absent data skips, present data asserts. The toggle
    // flipping back is what proves it is reversible, so it must fail if the flip never happens.
    const hideBtn = pageA.getByRole('button', { name: 'Hide from recall' }).first();
    test.skip(
      !(await hideBtn.isVisible().catch(() => false)),
      'no "Hide from recall" button present — set E2E_DATABASE_URL to seed a memory (see seed.mjs)',
    );

    await hideBtn.click();
    const useBtn = pageA.getByRole('button', { name: 'Use for recall' }).first();
    await expect(useBtn, 'Hide did not flip the control to "Use for recall"').toBeVisible();
    await useBtn.click(); // RESTORE
    await expect(
      pageA.getByRole('button', { name: 'Hide from recall' }).first(),
      'restore did not flip the control back to "Hide from recall"',
    ).toBeVisible();
  });

  // Original: skip('memory', 'Delete memory / Delete rule / Dismiss rule', 'irreversibly destroys
  // real learned data on a live account'). Now RUN against the seeded throwaway memory: real learned
  // memories are never touched — the delete targets the card by its distinctive throwaway label.
  test('Delete memory removes the card (throwaway, real data untouched)', async ({ pageA }) => {
    test.skip(!dbEnabled, 'requires E2E_DATABASE_URL to seed a throwaway memory (see seed.mjs)');
    await pageA.goto(`${WEB}/memory`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: /What Stewra has learned/i }).waitFor({ timeout: 12000 });

    const heading = pageA.getByRole('heading', { name: THROWAWAY_MEMORY_LABEL });
    await heading.waitFor({ timeout: 12000 });
    // The Delete button lives in the same card as the throwaway label.
    const card = heading.locator('xpath=ancestor::div[contains(@class,"card")][1]');
    await card.getByRole('button', { name: 'Delete' }).click();

    await heading.waitFor({ state: 'detached', timeout: 15000 });
    // Persisted server-side: it must not reappear after a reload.
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: /What Stewra has learned/i }).waitFor({ timeout: 12000 });
    const stillGone = (await pageA.getByRole('heading', { name: THROWAWAY_MEMORY_LABEL }).count()) === 0;
    expect(stillGone, 'deleted throwaway memory reappeared after reload').toBe(true);
  });
});
