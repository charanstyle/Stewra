// AUDIO call reliability probe: N attempts in FRESH context pairs (User A calls User B).
// Reports connect-success rate and captures any WebRTC/page errors.
//
//   node calls.audio.mjs [attempts=3]
//
// NOTE: incoming calls fan out to ALL of a user's logged-in devices. If a phone/emulator is
// signed in as either test user, its WebRTC signaling collides with this browser↔browser
// handshake and calls fail with "setRemoteDescription… wrong state: stable". Sign those
// devices out first (see ../../frontend/e2e/scripts/reset-devices.sh).
import { A, B, WEB, launchBrowser, contextFor, refreshAll, directConvId } from './lib.mjs';

const N = Number(process.argv[2] || 3);

async function attempt(browser, convId, n) {
  const errs = [];
  const ca = await contextFor(browser, A);
  const cb = await contextFor(browser, B);
  const pa = await ca.newPage();
  const pb = await cb.newPage();
  pa.on('pageerror', (e) => errs.push(`A:${e.message}`));
  pb.on('pageerror', (e) => errs.push(`B:${e.message}`));
  let result = 'unknown';
  try {
    await pa.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pb.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pa.locator('button[title="Audio call"]').waitFor({ timeout: 12000 });
    await pb.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    await pa.waitForTimeout(1500); // let sockets join the conversation room
    await pa.locator('button[title="Audio call"]').click();
    await pb.getByText(/Incoming audio call/i).waitFor({ timeout: 15000 });
    await pb.getByRole('button', { name: 'Answer' }).click();
    await Promise.all([
      pa.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
      pb.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
    ]);
    result = 'CONNECTED';
    await pa.waitForTimeout(800);
    await pa.locator('button[title="Hang up"]').click().catch(() => {});
  } catch (e) {
    result = 'FAILED: ' + String(e.message).split('\n')[0].slice(0, 90);
  }
  await ca.close();
  await cb.close();
  const extra = errs.length ? '  | errors: ' + [...new Set(errs)].join(' ; ') : '';
  console.log(`attempt ${n}/${N}: ${result}${extra}`);
  return result === 'CONNECTED';
}

(async () => {
  await refreshAll();
  const convId = await directConvId();
  console.log(`Probing AUDIO call connect ×${N} on ${WEB} (conv ${convId})\n`);
  const browser = await launchBrowser();
  let ok = 0;
  for (let i = 1; i <= N; i++) {
    if (await attempt(browser, convId, i)) ok += 1;
  }
  await browser.close();
  console.log(`\n=== AUDIO connect success: ${ok}/${N} ===`);
  process.exit(ok === N ? 0 : 1);
})();
