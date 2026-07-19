// Ported from the legacy full.mjs section "3. USER↔USER TEXT".
import { test, expect } from '../fixtures';
import { WEB } from '../lib.mjs';

const nonce = (): string => Math.random().toString(36).slice(2, 8);

test.describe('chat', () => {
  test('open conversation by clicking a list row (end-user)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: 'Chats' }).waitFor({ timeout: 12000 });
    await pageA.locator('li').first().click();
    await pageA.waitForURL('**/chats/**', { timeout: 10000 });
    await pageA.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
  });

  test('bidirectional live text + typing indicator', async ({ pageA, pageB, convId }) => {
    // make sure both are in the same thread
    await pageA.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pageB.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pageA.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    await pageB.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    await pageA.waitForTimeout(1500);

    // A → B (Send button)
    const m1 = `A→B ${nonce()}`;
    await pageA.getByPlaceholder('Type a message').fill(m1);
    await pageA.getByRole('button', { name: 'Send' }).click();
    await pageB.getByText(m1, { exact: false }).waitFor({ timeout: 12000 });

    // B → A via Enter key (tests Enter-to-send)
    const m2 = `B→A ${nonce()}`;
    await pageB.getByPlaceholder('Type a message').fill(m2);
    await pageB.getByPlaceholder('Type a message').press('Enter');
    await pageA.getByText(m2, { exact: false }).waitFor({ timeout: 12000 });

    // typing indicator: A types, B sees the composing indicator — a hard requirement in the
    // original. Two things this spec has to get right about the real web UI:
    //   1. Use pressSequentially (real per-key keydown/keypress/input events), NOT fill():
    //      ConversationPage fires setTyping(true) off the composer's onChange keystrokes, which
    //      fill()'s single value-set does not produce.
    //   2. The web indicator is TypingIndicator.tsx — three bouncing dots in a
    //      `<div aria-label="typing">`, NOT literal "typing…" text. Match the aria-label.
    const composer = pageA.getByPlaceholder('Type a message');
    await composer.click();
    await composer.pressSequentially('composing…', { delay: 60 });
    let typing = false;
    try {
      await pageB.getByLabel('typing').waitFor({ timeout: 6000 });
      typing = true;
    } catch {
      // fall through — asserted below
    }
    await composer.fill('');
    expect(typing, `typingIndicator=${typing}`).toBe(true);

    // timestamps present on bubbles — info-only, per TESTIDS.md.
    const stamped = await pageA.getByTestId('message-timestamp').first().isVisible().catch(() => false);
    console.log(`[chat] message timestamps rendered: timestamp element visible=${stamped}`);
  });

  test('Back button returns to list', async ({ pageA, convId }) => {
    // Each Playwright test starts from a fresh page, unlike the original linear script (which
    // relied on still being inside the conversation from the previous check) — navigate there
    // explicitly first.
    await pageA.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pageA.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    await pageA.getByRole('button', { name: /Back/ }).click();
    await pageA.waitForURL('**/chats', { timeout: 10000 });
  });
});
