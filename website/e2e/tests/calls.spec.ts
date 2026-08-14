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
import { A, B, WEB, apiCall, contextFor } from '../lib.mjs';

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

/**
 * Calls force-relay (`iceTransportPolicy: 'relay'`), so every one of them dies the same opaque way
 * when coturn is unreachable: the banner rings, Answer works, and then "Connected" simply never
 * appears until the 30s timeout. That timeout says nothing about WHY, and the cause is usually the
 * router port-forward documented in deploy/coturn-stewra.md ("the one manual step") rather than
 * anything in the app.
 *
 * So ask the question directly before the suite runs: fetch real TURN credentials and try to gather a
 * relay candidate from them. This never skips a test — a broken TURN is a broken product, and the
 * call tests below must still fail — it only names the cause in the log.
 *
 * `session` is what logs A in; without it the credentials call runs unauthenticated and 401s. Probing
 * once per worker keeps Playwright's per-test retries from paying the 10s gather again.
 */
let turnProbed = false;
test.beforeAll(async ({ browser, session }) => {
  void session; // ensures A has a token before the credentials call below
  if (turnProbed) return;
  turnProbed = true;
  const res = await apiCall('/calls/turn-credentials');
  const iceServers = res.json?.data?.iceServers;
  if (!iceServers) {
    console.log(`[call] TURN preflight: /calls/turn-credentials returned HTTP ${res.status} with no iceServers`);
    return;
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const relays = await page.evaluate(async (servers) => {
    const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
    const found: string[] = [];
    pc.onicecandidate = (e): void => {
      if (e.candidate) found.push(e.candidate.candidate);
    };
    pc.createDataChannel('turn-preflight');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 10000));
    pc.close();
    return found.length;
  }, iceServers);
  await ctx.close();
  console.log(
    relays > 0
      ? `[call] TURN preflight: ${relays} relay candidate(s) from ${JSON.stringify(iceServers[0].urls)} — relay path is up`
      : `[call] TURN preflight: NO relay candidates from ${JSON.stringify(iceServers[0].urls)}. ` +
          'coturn is unreachable from this network, so no call below can reach "Connected". ' +
          'See deploy/coturn-stewra.md — the router forward for UDP/TCP 3481 + UDP 49202-49250 is the usual cause.',
  );
});

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
    await expect(pageA.locator('button[title="Unmute"]')).toBeVisible();
    await pageA.locator('button[title="Unmute"]').click();
    await expect(pageA.locator('button[title="Mute"]')).toBeVisible();
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
    // `toBeHidden` retries and throws. The previous shape was the dangerous direction of this
    // anti-pattern: `false` was the PASS value, so `.catch(() => false)` turned any error in the
    // visibility query itself into a green test — and the instantaneous `isVisible()` reported
    // "not in call" the moment before the CallScreen would have been found still up.
    await expect(pageA.getByText(/Ringing…|Connected/)).toBeHidden();
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
    // The camera toggle is not optional in a VIDEO call: CallScreen.tsx renders it under
    // `{isVideo && ...}`, and this test is inside a connected video call. The old `isVisible()`
    // guard sampled the DOM instantly and, on a control that had not painted yet, took the else
    // branch and passed — so a video call that lost its camera button entirely stayed green.
    const camBtn = pageA.locator('button[title="Turn camera off"]');
    await expect(camBtn).toBeVisible();
    await camBtn.click();
    await expect(pageA.locator('button[title="Turn camera on"]')).toBeVisible();
    await pageA.locator('button[title="Turn camera on"]').click();
    await expect(camBtn).toBeVisible();
    await pageA.waitForTimeout(1200);
    await pageA.locator('button[title="Hang up"]').click();
    await pageA
      .getByText('Connected', { exact: true })
      .waitFor({ state: 'hidden', timeout: 10000 })
      .catch(() => {});
    await pageA.getByText(/Video call started/i).last().waitFor({ timeout: 8000 });
    // The inline "ended" marker is the user-visible record that the call was torn down cleanly.
    // Converting a boolean nobody asserted into a real wait: `waitFor` already throws on timeout,
    // so the `.then(true).catch(false)` around it existed only to discard that failure.
    await expect(pageA.getByText(/Video call ended/i).last()).toBeVisible({ timeout: 8000 });
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
