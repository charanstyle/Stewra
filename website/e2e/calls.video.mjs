// VIDEO call reliability probe: N attempts in FRESH context pairs (User A calls User B),
// plus an in-call camera-toggle check. Reports connect-success rate and page errors.
//
//   node calls.video.mjs [attempts=3]
//
// See calls.audio.mjs for the device-interference caveat.
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
  let camera = 'n/a';
  try {
    await pa.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pb.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await pa.locator('button[title="Video call"]').waitFor({ timeout: 12000 });
    await pb.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    await pa.waitForTimeout(1500); // let sockets join the conversation room
    await pa.locator('button[title="Video call"]').click();
    await pb.getByText(/Incoming video call/i).waitFor({ timeout: 15000 });
    await pb.getByRole('button', { name: 'Answer' }).click();
    await Promise.all([
      pa.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
      pb.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
    ]);
    result = 'CONNECTED';
    // Video starts enabled → the control offers "Turn camera off"; toggle off then back on.
    try {
      await pa.locator('button[title="Turn camera off"]').click({ timeout: 5000 });
      await pa.locator('button[title="Turn camera on"]').waitFor({ timeout: 5000 });
      await pa.locator('button[title="Turn camera on"]').click();
      await pa.locator('button[title="Turn camera off"]').waitFor({ timeout: 5000 });
      camera = 'toggle OK';
    } catch (e) {
      camera = 'toggle FAILED: ' + String(e.message).split('\n')[0].slice(0, 60);
    }
    await pa.waitForTimeout(500);
    await pa.locator('button[title="Hang up"]').click().catch(() => {});
  } catch (e) {
    result = 'FAILED: ' + String(e.message).split('\n')[0].slice(0, 90);
  }
  await ca.close();
  await cb.close();
  const extra = errs.length ? '  | errors: ' + [...new Set(errs)].join(' ; ') : '';
  console.log(`attempt ${n}/${N}: ${result}  | camera: ${camera}${extra}`);
  return result === 'CONNECTED';
}

(async () => {
  await refreshAll();
  const convId = await directConvId();
  console.log(`Probing VIDEO call connect ×${N} on ${WEB} (conv ${convId})\n`);
  const browser = await launchBrowser();
  let ok = 0;
  for (let i = 1; i <= N; i++) {
    if (await attempt(browser, convId, i)) ok += 1;
  }
  await browser.close();
  console.log(`\n=== VIDEO connect success: ${ok}/${N} ===`);
  process.exit(ok === N ? 0 : 1);
})();
