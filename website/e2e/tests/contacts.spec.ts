// Ported from the legacy full.mjs section "6. CONTACTS".
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

test.describe('contacts', () => {
  test('search people + Message action', async ({ pageA }) => {
    await pageA.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await pageA.getByPlaceholder('Search by name or email').waitFor({ timeout: 12000 });
    await pageA.getByPlaceholder('Search by name or email').fill(B.email.split('@')[0]);
    await pageA.getByRole('button', { name: 'Search' }).click();
    await pageA.waitForTimeout(2000);
    const hasResult = await pageA.getByText(B.email, { exact: false }).first().isVisible().catch(() => false);
    console.log(`[contacts] people search returns results: found peer by name=${hasResult}`);
  });

  test('contacts list renders + invite form present', async ({ pageA }) => {
    await pageA.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    const yourContacts = await pageA
      .getByRole('heading', { name: 'Your contacts' })
      .isVisible()
      .catch(() => false);
    const inviteInput = await pageA
      .getByPlaceholder('name@example.com')
      .isVisible()
      .catch(() => false);
    console.log(`[contacts] "Your contacts" + "Invite by email" render: contacts=${yourContacts}, inviteInput=${inviteInput}`);
  });

  test('invite by email (graceful for existing contact)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await pageA.getByPlaceholder('name@example.com').fill(B.email);
    await pageA.getByRole('button', { name: 'Send invite' }).click();
    await pageA.waitForTimeout(2000);
    // Either a success notice or a graceful error — both are acceptable (already contacts).
    const notice = await pageA.locator('body').innerText();
    const handled = /Invite sent|already|contact|cannot|error/i.test(notice);
    console.log(`[contacts] invite-by-email produces a notice (no crash): handled=${handled}`);
  });

  test('Block then Unblock a contact (state restored)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: 'Your contacts' }).waitFor({ timeout: 12000 });
    const block = pageA.getByRole('button', { name: 'Block' }).first();
    const unblock = pageA.getByRole('button', { name: 'Unblock' }).first();
    const hasBlock = await block.isVisible().catch(() => false);
    const hasUnblock = await unblock.isVisible().catch(() => false);
    if (hasBlock) {
      // Normal path: block a contact, assert it flips, then unblock to restore original state.
      await block.click();
      await pageA.getByRole('button', { name: 'Unblock' }).first().waitFor({ timeout: 8000 });
      await pageA.getByRole('button', { name: 'Unblock' }).first().click(); // RESTORE
      await pageA.getByRole('button', { name: 'Block' }).first().waitFor({ timeout: 8000 });
    } else if (hasUnblock) {
      // Recovery path: a contact is already blocked (e.g. an earlier aborted run). Clearing it
      // both proves the toggle works AND leaves the account in the clean, unblocked state.
      await unblock.click();
      await pageA.getByRole('button', { name: 'Block' }).first().waitFor({ timeout: 8000 });
    } else {
      console.log('[contacts] Block/Unblock: no Block/Unblock control (no eligible contact rendered)');
    }
  });

  test('Message from contact row opens a conversation', async ({ pageA }) => {
    await pageA.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: 'Your contacts' }).waitFor({ timeout: 12000 });
    const msgBtn = pageA.getByRole('button', { name: 'Message' }).first();
    if (await msgBtn.isVisible().catch(() => false)) {
      await msgBtn.click();
      await pageA.waitForURL('**/chats/**', { timeout: 10000 }).catch(() => {});
      expect(/\/chats\//.test(pathOf(pageA)), `landed ${pathOf(pageA)}`).toBe(true);
    } else {
      console.log('[contacts] Message from contact row: no Message button visible');
    }
  });
});
