// Ported from the legacy full.mjs section "4. CALLS (audio / decline / video)" plus the
// standalone reliability probes calls.audio.mjs and calls.video.mjs (N fresh-context attempts,
// reporting a connect-success rate).
//
// CAVEAT (kept from calls.audio.mjs / calls.video.mjs): incoming calls fan out to ALL of a
// user's logged-in devices. If a phone/emulator is signed in as either QA user, its WebRTC
// signaling collides with this browser↔browser handshake and calls fail with
// "setRemoteDescription… wrong state: stable". Sign those devices out first — see
// ../../frontend/e2e/scripts/reset-devices.sh.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { A, B, WEB, contextFor } from '../lib.mjs';

/** Number of fresh-context attempts for the connect-reliability probes (matches the old
 * scripts' default `node calls.audio.mjs [attempts=3]`). */
const RELIABILITY_ATTEMPTS = 3;

async function placeCall(
  pageA: Page,
  pageB: Page,
  convId: string,
  kind: 'audio' | 'video',
  incomingText: RegExp,
): Promise<void> {
  await pageA.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
  await pageB.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
  const title = kind === 'video' ? 'Video call' : 'Audio call';
  await pageA.locator(`button[title="${title}"]`).waitFor({ timeout: 12000 });
  await pageA.waitForTimeout(1200);
  await pageA.locator(`button[title="${title}"]`).click();
  await pageB.getByText(incomingText).waitFor({ timeout: 15000 });
}

test.describe('call', () => {
  test('AUDIO call: ring → answer → connect → mute → hang up → markers', async ({
    pageA,
    pageB,
    convId,
  }) => {
    // Runs on both desktop- and mobile-chromium: verified live that the call `.controls`
    // (Mute / Hang-up) are fully clickable at phone width — the earlier "stage overlaps controls"
    // skip was a misdiagnosis of a transient WebRTC handshake collision (see the file-top caveat
    // about signed-in devices), not a layout bug.
    await placeCall(pageA, pageB, convId, 'audio', /Incoming audio call/i);
    await pageB.getByRole('button', { name: 'Answer' }).click();
    await pageA.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 });
    await pageB.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 });

    // mute toggle
    await pageA.locator('button[title="Mute"]').click();
    const unmuteShown = await pageA
      .locator('button[title="Unmute"]')
      .isVisible()
      .catch(() => false);
    expect(unmuteShown, `unmute visible=${unmuteShown}`).toBe(true);
    if (unmuteShown) {
      await pageA.locator('button[title="Unmute"]').click();
    }
    await pageA.waitForTimeout(1200);
    await pageA.locator('button[title="Hang up"]').click();
    await pageA
      .getByText('Connected', { exact: true })
      .waitFor({ state: 'hidden', timeout: 10000 })
      .catch(() => {});

    // inline system markers in the thread
    await pageA.getByText(/Voice call started/i).last().waitFor({ timeout: 8000 });
    await pageA.getByText(/Voice call ended/i).last().waitFor({ timeout: 8000 });
  });

  test('AUDIO call decline: caller returns to idle', async ({ pageA, pageB, convId }) => {
    await placeCall(pageA, pageB, convId, 'audio', /Incoming audio call/i);
    await pageB.getByRole('button', { name: 'Decline' }).click();
    // caller's CallScreen (Ringing…/Connecting…/Connected) should disappear.
    await pageA
      .getByText(/Ringing…|Connecting…|Connected/)
      .waitFor({ state: 'hidden', timeout: 12000 })
      .catch(() => {});
    const stillInCall = await pageA
      .getByText(/Ringing…|Connected/)
      .isVisible()
      .catch(() => false);
    expect(stillInCall, `stillInCall=${stillInCall}`).toBe(false);
  });

  test('VIDEO call: ring → answer → connect → camera toggle → hang up → markers', async ({
    pageA,
    pageB,
    convId,
  }) => {
    // See the AUDIO test above: mobile-web call controls are clickable at phone width; this runs
    // on both projects.
    await placeCall(pageA, pageB, convId, 'video', /Incoming video call/i);
    await pageB.getByRole('button', { name: 'Answer' }).click();
    await pageA.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 });
    await pageB.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 });

    // camera toggle (video-only control)
    const camBtn = pageA.locator('button[title="Turn camera off"]');
    if (await camBtn.isVisible().catch(() => false)) {
      await camBtn.click();
      const camOn = await pageA
        .locator('button[title="Turn camera on"]')
        .isVisible()
        .catch(() => false);
      expect(camOn, `flipped=${camOn}`).toBe(true);
      if (camOn) {
        await pageA.locator('button[title="Turn camera on"]').click();
      }
    } else {
      console.log('[call] camera toggle control not visible');
    }
    await pageA.waitForTimeout(1200);
    await pageA.locator('button[title="Hang up"]').click();
    await pageA
      .getByText('Connected', { exact: true })
      .waitFor({ state: 'hidden', timeout: 10000 })
      .catch(() => {});
    await pageA.getByText(/Video call started/i).last().waitFor({ timeout: 8000 });
    const endedShown = await pageA
      .getByText(/Video call ended/i)
      .last()
      .waitFor({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    console.log(`[call] video call ended marker shown=${endedShown}`);
  });

  test(`AUDIO call connects reliably across ${RELIABILITY_ATTEMPTS} fresh-context attempts`, async ({
    browser,
    convId,
  }) => {
    let ok = 0;
    for (let i = 1; i <= RELIABILITY_ATTEMPTS; i++) {
      const connected = await attemptConnect(browser, convId, 'audio');
      console.log(`[call] audio reliability attempt ${i}/${RELIABILITY_ATTEMPTS}: ${connected ? 'CONNECTED' : 'FAILED'}`);
      if (connected) ok += 1;
    }
    expect(ok, `${ok}/${RELIABILITY_ATTEMPTS} audio attempts connected`).toBe(RELIABILITY_ATTEMPTS);
  });

  test(`VIDEO call connects reliably across ${RELIABILITY_ATTEMPTS} fresh-context attempts`, async ({
    browser,
    convId,
  }) => {
    let ok = 0;
    for (let i = 1; i <= RELIABILITY_ATTEMPTS; i++) {
      const connected = await attemptConnect(browser, convId, 'video');
      console.log(`[call] video reliability attempt ${i}/${RELIABILITY_ATTEMPTS}: ${connected ? 'CONNECTED' : 'FAILED'}`);
      if (connected) ok += 1;
    }
    expect(ok, `${ok}/${RELIABILITY_ATTEMPTS} video attempts connected`).toBe(RELIABILITY_ATTEMPTS);
  });
});

/** One fresh-context connect attempt (own contexts, not the shared pageA/pageB fixtures) — the
 * same "fresh context pair per attempt" shape as the old calls.audio.mjs / calls.video.mjs. */
async function attemptConnect(browser: Browser, convId: string, kind: 'audio' | 'video'): Promise<boolean> {
  const ca: BrowserContext = await contextFor(browser, A);
  const cb: BrowserContext = await contextFor(browser, B);
  const pa: Page = await ca.newPage();
  const pb: Page = await cb.newPage();
  const errs: string[] = [];
  pa.on('pageerror', (e: Error) => errs.push(`A:${e.message}`));
  pb.on('pageerror', (e: Error) => errs.push(`B:${e.message}`));
  const title = kind === 'video' ? 'Video call' : 'Audio call';
  const incoming = kind === 'video' ? /Incoming video call/i : /Incoming audio call/i;
  let connected = false;
  try {
    await pa.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pb.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pa.locator(`button[title="${title}"]`).waitFor({ timeout: 12000 });
    await pb.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    await pa.waitForTimeout(1500); // let sockets join the conversation room
    await pa.locator(`button[title="${title}"]`).click();
    await pb.getByText(incoming).waitFor({ timeout: 15000 });
    await pb.getByRole('button', { name: 'Answer' }).click();
    await Promise.all([
      pa.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
      pb.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
    ]);
    connected = true;
    await pa.waitForTimeout(800);
    await pa.locator('button[title="Hang up"]').click().catch(() => {});
  } catch (e) {
    console.log(`[call] attempt failed: ${String((e as Error).message).split('\n')[0].slice(0, 120)}`);
  } finally {
    if (errs.length > 0) {
      console.log(`[call] page errors: ${[...new Set(errs)].join(' ; ')}`);
    }
    await ca.close();
    await cb.close();
  }
  return connected;
}
