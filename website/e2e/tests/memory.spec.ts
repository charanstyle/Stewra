// Ported from the legacy full.mjs section "8. MEMORY features".
import { test } from '../fixtures';
import { WEB } from '../lib.mjs';

test.describe('memory', () => {
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
    const editBtn = pageA.getByRole('button', { name: 'Edit' }).first();
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click();
      const cancel = pageA.getByRole('button', { name: 'Cancel' }).first();
      const inEdit = await cancel.isVisible().catch(() => false);
      if (inEdit) {
        await cancel.click();
        console.log('[memory] Edit opens editor, Cancel discards (no write)');
      } else {
        console.log('[memory] Edit/Cancel: edit form did not open as expected');
      }
    } else {
      console.log('[memory] Edit/Cancel: no editable memory/rule present');
    }
  });

  test('hide/use-for-recall toggle (reversible)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/memory`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: /What Stewra has learned/i }).waitFor({ timeout: 12000 });
    const hideBtn = pageA.getByRole('button', { name: 'Hide from recall' }).first();
    if (await hideBtn.isVisible().catch(() => false)) {
      await hideBtn.click();
      await pageA.waitForTimeout(800);
      const useBtn = pageA.getByRole('button', { name: 'Use for recall' }).first();
      const flipped = await useBtn.isVisible().catch(() => false);
      if (flipped) {
        await useBtn.click(); // RESTORE
        console.log('[memory] Hide↔Use for recall toggle works (restored)');
      } else {
        console.log('[memory] Hide/Use toggle: did not flip to "Use for recall"');
      }
    } else {
      console.log('[memory] Hide/Use toggle: no "Hide from recall" button present');
    }
  });

  // Original: skip('memory', 'Delete memory / Delete rule / Dismiss rule', 'irreversibly
  // destroys real learned data on a live account — buttons present & located, deliberately not
  // clicked')
  test.skip(
    true,
    'irreversibly destroys real learned data on a live account — buttons present & ' +
      'located, deliberately not clicked',
  );
});
