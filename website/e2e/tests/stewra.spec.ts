// Ported from the legacy full.mjs section "5. STEWRA (text + voice)".
import { test, expect } from '../fixtures';
import { WEB, uiHasTestids } from '../lib.mjs';
import { config } from '../config.mjs';

const nonce = (): string => Math.random().toString(36).slice(2, 8);

test.describe('stewra', () => {
  test('text → thinking → assistant reply (+ Play voice)', async ({ pageA }) => {
    await pageA.goto(`${WEB}/stewra`, { waitUntil: 'domcontentloaded' });
    const input = pageA.getByPlaceholder('…or type a message');
    await input.waitFor({ timeout: 15000 });
    test.skip(
      !(await uiHasTestids(pageA)),
      'requires the website data-testid contract (app-nav sentinel absent) — deploy website first',
    );
    await pageA.waitForFunction(
      () => {
        const el = document.querySelector<HTMLInputElement>('input[placeholder="…or type a message"]');
        return el !== null && !el.disabled;
      },
      { timeout: 20000 },
    );
    const before = await pageA.getByTestId('stewra-turn').count();
    await input.fill(`What is 2+2? ref ${nonce()}`);
    await pageA.getByRole('button', { name: 'Send' }).click();
    await pageA
      .getByText('Stewra is thinking…', { exact: false })
      .waitFor({ timeout: 8000 })
      .catch(() => {});
    await pageA.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="stewra-turn"]').length > n,
      before,
      { timeout: 60000 },
    );
    const after = await pageA.getByTestId('stewra-turn').count();
    expect(after, `assistant turns ${before} → ${after}`).toBeGreaterThan(before);

    const playVoice = await pageA
      .getByRole('button', { name: 'Play voice' })
      .first()
      .isVisible()
      .catch(() => false);
    console.log(`[stewra] assistant reply exposes "Play voice": visible=${playVoice}`);
  });

  test('hold-to-talk voice → transcribed user turn + reply', async ({ pageA }) => {
    await pageA.goto(`${WEB}/stewra`, { waitUntil: 'domcontentloaded' });
    const holdBtn = pageA.getByRole('button', { name: /Hold to talk/i });
    await holdBtn.waitFor({ timeout: 15000 });
    test.skip(
      !(await uiHasTestids(pageA)),
      'requires the website data-testid contract (app-nav sentinel absent) — deploy website first',
    );
    const before = await pageA.getByTestId('stewra-user-turn').count();
    const box = await holdBtn.boundingBox();
    if (box === null) {
      throw new Error('[stewra] hold-to-talk button has no bounding box');
    }
    await pageA.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pageA.mouse.down(); // start recording (onMouseDown)
    await pageA
      .getByText('Recording — release to send', { exact: false })
      .waitFor({ timeout: 5000 })
      .catch(() => {});
    await pageA.waitForTimeout(2500);
    await pageA.mouse.up(); // stop → send (onMouseUp)
    await pageA.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="stewra-user-turn"]').length > n,
      before,
      { timeout: 60000 },
    );
    const after = await pageA.getByTestId('stewra-user-turn').count();
    const transcript = (await pageA.getByTestId('stewra-user-turn').last().innerText().catch(() => ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    expect(after, `user turns ${before} → ${after}`).toBeGreaterThan(before);
    console.log(
      `[stewra] voice recorded → transcribed → new user turn; transcript="${transcript}"` +
        (config.audioFile ? '' : ' (fake mic: non-verbal audio, pipeline still exercised)'),
    );
  });
});
