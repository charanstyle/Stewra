// Ported from the legacy full.mjs section "9. BY-DESIGN GAPS". These are deliberate product
// gaps, not bugs — kept as real, hard assertions (not soft/info) so a regression that
// accidentally ships call buttons on the Stewra thread, or a mic on the human composer, fails
// the suite.
import { test, expect } from '../fixtures';
import { WEB } from '../lib.mjs';

test.describe('gaps', () => {
  test('Stewra thread exposes NO call buttons (by design)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/stewra`, { waitUntil: 'domcontentloaded' });
    await pageA.getByPlaceholder('…or type a message').waitFor({ timeout: 12000 });
    const audio = await pageA.locator('button[title="Audio call"]').count();
    const video = await pageA.locator('button[title="Video call"]').count();
    expect(audio + video, `audio=${audio}, video=${video} (expected 0/0)`).toBe(0);
  });

  test('human composer has NO mic (parity gap vs mobile app)', async ({ pageA, convId }) => {
    await pageA.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pageA.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    const mic = await pageA.getByRole('button', { name: /Hold to talk|mic|record/i }).count();
    // Expected 0 today — the mobile app has had hold-to-talk voice compose in 1:1 chat since
    // d352bef; the website hasn't. A pass here confirms parity, not a gap.
    expect(mic, `mic buttons=${mic} (mobile app has it since d352bef)`).toBe(0);
  });
});
